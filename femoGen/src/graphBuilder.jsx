
// ═══════════════════════════════════════════════════════════════
// ═══ graphBuilder.jsx ═══
// ═══════════════════════════════════════════════════════════════


import { nid, eid, mid, actionId, getNodeSize, makeDefaultNodes, SPW, SPH } from './common';

// ═══ Convert parsed FEMO to internal graph state ═══
function parsedToGraph(parsed, currentMode, currentModName) {
  const proj = {
    id: parsed.meta.id || '',
    name: parsed.meta.name || '未命名项目',
    version: parsed.meta.version || '1.0',
    owner: parsed.meta.owner || '',
    database: parsed.meta.database || '',
    session: parsed.meta.session || '',
    system_safety: parsed.meta.system_safety || '',
    output_style: parsed.meta.output_style || '',
    // 文件头原文（meta: 之前的注释）透传给生成端回写，见 femoParser.parseFEMO
    preamble: parsed.preamble || '',
    code: parsed.code || [],
    vars: (parsed.vars || []).map(v => ({ name: v.name, defaultValue: v.defaultValue })),
    actors: parsed.actors.map((a) => ({
      name: a.name.startsWith('@') ? a.name : '@' + a.name,
      type: a.type,
      soul: a.soul,
      source: a.source,
      // ⚠️ tools 五态直通，不许归一：null=未声明（宿主默认全开）/ false=禁用 /
      // true=显式全开 / []=显式空白名单（≡禁用）/ [..]=白名单。
      // 历史教训：a.tools || [] 曾把 false 吞成 []（禁用标记静默丢失）；
      // ?? [] 也曾把「未声明」和「显式空列表」搅混（2026-09-12）。
      tools: a.tools,
      thinking: a.thinking || '',
    })),
  };

  // ═══ 构建所有 action 列表（主流程 + 所有模块内部）═══
  let libActions = parsed.actions.map((a) => ({
    id: actionId(['mainflow'], a.name),
    path: ['mainflow'],
    ...a,
  }));

  // 提前收集各模块内部 action，并分配稳定 ID 与路径
  const moduleInternalActions = [];
  parsed.modules.forEach((m) => {
    const modPath = m.path || ['mainflow', m.name];
    (m.actions || []).forEach((a) => {
      moduleInternalActions.push({
        id: actionId(modPath, a.name),
        path: modPath,
        ...a,
      });
    });
  });

  // 合并所有 action，保证后续构建图时任何模块都能找到自己的 action
  libActions = libActions.concat(moduleInternalActions);

  // ═══ 构建所有模块图 ═══
  const libModules = parsed.modules.map((m) => {
    const modPath = m.path || ['mainflow', m.name];
    const { nodes: mNodes, edges: mEdges } = flowDeclsToGraph(
      m.nodeDecls,
      m.edges,
      'module',
      libActions,   // 现在已经包含该模块的 action
      parsed.modules,
      m.layout || {}
    );
    // 该模块自身的 action 列表（从 moduleInternalActions 中过滤）
    const internalActions = moduleInternalActions.filter(
      (a) => a.path.length === modPath.length && a.path.every((seg, i) => seg === modPath[i])
    );
    return {
      id: mid(),
      name: m.name,
      path: modPath,
      meta: m.meta || {},
      code: m.code || [],
      vars: m.vars || [],
      nodes: mNodes,
      edges: mEdges,
      internalActions,
    };
  });
  // 注意：moduleInternalActions 已经合并入 libActions，无需再次合并

  // Determine which flow to load onto canvas
  let flowDecls, flowMode;
  if (currentMode === 'module' && currentModName) {
    const targetMod = parsed.modules.find((m) => m.name === currentModName);
    if (targetMod) {
      flowDecls = { nodeDecls: targetMod.nodeDecls, edges: targetMod.edges, layout: targetMod.layout || {} };
      flowMode = 'module';
    } else {
      throw new Error(
        `FEMO 脚本中未找到名为 "${currentModName}" 的 module 定义。请确认 module 名称拼写正确`
      );
    }
  } else {
    flowDecls = parsed.mainflow;
    flowMode = 'mainflow';
  }

  const { nodes, edges } = flowDeclsToGraph(
    flowDecls.nodeDecls,
    flowDecls.edges,
    flowMode,
    libActions,
    parsed.modules,
    flowDecls.layout || {}
  );

  // 无论当前在哪个视图，都计算 mainflow 的图（供 flowStore 使用）
  let mainflowNodes, mainflowEdges;
  if (flowMode === 'mainflow') {
    mainflowNodes = nodes;
    mainflowEdges = edges;
  } else {
    //console.log('[parsedToGraph] flowMode !== mainflow, 重新构建 mainflow 图, layout:', parsed.mainflow.layout);
    const mainResult = flowDeclsToGraph(
      parsed.mainflow.nodeDecls,
      parsed.mainflow.edges,
      'mainflow',
      libActions,
      parsed.modules,
      parsed.mainflow.layout || {}
    );
    mainflowNodes = mainResult.nodes;
    mainflowEdges = mainResult.edges;
    //console.log('[parsedToGraph] mainflow 图构建结果: nodes=', mainflowNodes.map(n => `${n.label}(${Math.round(n.x)},${Math.round(n.y)})`));
  }

  return { proj, libActions, libModules, nodes, edges, mainflowNodes, mainflowEdges };
}

const SPECIAL_LABELS = new Set(['START', 'END', 'IN', 'OUT', 'BREAK']);

function flowDeclsToGraph(
  nodeDecls,
  flowEdges,
  mode,
  libActions,
  parsedModules,
  layoutMap = {}
) {
  const ANCHOR_X = 80;
  const ANCHOR_Y = 200;
  const lp = (label, defaultX, defaultY) => {
    const e = layoutMap[label] || layoutMap[`[${label}]`];
    if (e) {
      return { x: e.dx !== undefined ? e.dx : 0, y: e.dy !== undefined ? e.dy : 0 };
    }
    return { x: defaultX, y: defaultY };
  };
  const nodes = [];
  const edges = [];
  const labelToId = new Map();

  // Collect all labels referenced in flow edges
  const allLabels = new Set();
  for (const fe of flowEdges) {
    allLabels.add(fe.srcLabel);
    allLabels.add(fe.tgtLabel);
  }

  // Create special nodes from flow references
  let specialY = 200;
  const forNodeMap = new Map(); // forLabel -> { forNodeId, forOutNodeId }

  // 先处理所有 FOR/PAR 节点的声明，创建 FOR/PAR 和对应出口节点
  for (const decl of nodeDecls) {
    if (decl.specialType === 'FOR' || decl.specialType === 'PAR') {
      const isPar = decl.specialType === 'PAR';
      const spType = isPar ? 'PAR' : 'FOR';
      const outType = isPar ? 'par_out' : 'for_out';
      const outSpType = isPar ? 'PAR_OUT' : 'FOR_OUT';
      const forId = nid();
      const outId = nid();
      const pos = lp(`[${decl.label}]`, 200, specialY);
      const xPos = pos.x;
      const yPos = pos.y;

      // 特殊节点
      nodes.push({
        id: forId,
        type: 'special',
        specialType: spType,
        x: xPos,
        y: yPos,
        label: `[${decl.label}]`,
        forOutNodeId: outId,
        forCondition: decl.forCondition || '',
      });

      // 出口节点坐标：优先使用 sketch 中的 [label_出] 或 [label_out]
      const outKey1 = `${decl.label}_出`;
      const outKey2 = `${decl.label}_out`;
      const outLayout = layoutMap[outKey1] || layoutMap[`[${outKey1}]`] || layoutMap[outKey2] || layoutMap[`[${outKey2}]`];
      const outX = outLayout ? outLayout.dx : (xPos + SPW - 22);
      const outY = outLayout ? outLayout.dy : (yPos + (SPH - 22) / 2);

      // 出口节点
      nodes.push({
        id: outId,
        type: outType,
        specialType: outSpType,
        x: outX,
        y: outY,
        label: `[${decl.label}_出]`,
        forNodeId: forId,
      });

      labelToId.set(decl.label, forId);
      labelToId.set(`[${decl.label}]`, forId);
      labelToId.set(`${decl.label}_out`, outId);
      labelToId.set(`[${decl.label}_out]`, outId);
      labelToId.set(outKey1, outId);
      labelToId.set(`[${outKey1}]`, outId);

      forNodeMap.set(decl.label, { forId, outId });
      specialY += 100;
    }
  }

  // 再处理其他特殊节点
  for (const lbl of allLabels) {
    if (!SPECIAL_LABELS.has(lbl) && !lbl.match(/^(END|OUT|BREAK)_\d+$/))
      continue;
    // 跳过已经被 FOR 节点占用的标签
    if (labelToId.has(lbl) || labelToId.has(`[${lbl}]`)) continue;

    const baseType = lbl.replace(/_\d+$/, '');
    const id = nid();
    const defX = baseType === 'START' || baseType === 'IN' ? 0 : 600;
    const pos = lp(`[${lbl}]`, defX, specialY);
    nodes.push({
      id,
      type: 'special',
      specialType: baseType,
      x: pos.x,
      y: pos.y,
      label: `[${lbl}]`,
    });
    labelToId.set(lbl, id);
    labelToId.set(`[${lbl}]`, id);
    specialY += 80;
  }

  // Ensure default entry/exit exist
  const entryType = mode === 'mainflow' ? 'START' : 'IN';
  const exitType = mode === 'mainflow' ? 'END' : 'OUT';
  if (!labelToId.has(entryType)) {
    const id = nid();
    nodes.push({
      id,
      type: 'special',
      specialType: entryType,
      x: 80,
      y: 200,
      label: `[${entryType}]`,
    });
    labelToId.set(entryType, id);
    labelToId.set(`[${entryType}]`, id);
  }
  if (!labelToId.has(exitType)) {
    const id = nid();
    nodes.push({
      id,
      type: 'special',
      specialType: exitType,
      x: 600,
      y: 200,
      label: `[${exitType}]`,
    });
    labelToId.set(exitType, id);
    labelToId.set(`[${exitType}]`, id);
  }

  // Create nodes from declarations
  let col = 0,
    row = 0;
  for (const decl of nodeDecls) {
    if (labelToId.has(decl.label) || labelToId.has(`[${decl.label}]`)) continue;

    const id = nid();
    const label = `[${decl.label}]`;
    labelToId.set(decl.label, id);
    labelToId.set(label, id);

    const joinEntries = decl.joinEntries || [];

    if (decl.ref === '') {
      const pos = lp(label, 180 + col * 240, 120 + row * 140);
      nodes.push({ id, type: 'position', x: pos.x, y: pos.y, label, joinEntries });
    } else if (decl.ref.startsWith('&')) {
      const modName = decl.ref.substring(1);
      const modDef = parsedModules?.find((m) => m.name === modName);
      const pos = lp(label, 180 + col * 260, 120 + row * 150);
      nodes.push({ id, type: 'module', modRef: modName, modDef, x: pos.x, y: pos.y, label, joinEntries });
    } else {
      const actionDef = libActions.find((a) => a.name === decl.ref);
      if (!actionDef) {
        throw new Error(
          `节点 "${decl.label}" 引用了未定义的 action "${decl.ref}"`
        );
      }
      const pos = lp(label, 180 + col * 240, 120 + row * 140);
      nodes.push({
        id,
        type: 'action',
        actionId: actionDef.id,
        x: pos.x,
        y: pos.y,
        label,
        joinEntries,
      });
    }
    col++;
    if (col >= 3) {
      col = 0;
      row++;
    }
  }

  // Create edges
  for (const fe of flowEdges) {
    //console.log('[flowDeclsToGraph] 处理边 srcLabel=', fe.srcLabel, 'tgtLabel=', fe.tgtLabel, 'cond=', fe.cond);
    const srcId =
      labelToId.get(fe.srcLabel) || labelToId.get(`[${fe.srcLabel}]`);
    const tgtId =
      labelToId.get(fe.tgtLabel) || labelToId.get(`[${fe.tgtLabel}]`);
    //console.log('[flowDeclsToGraph] srcId=', srcId, 'tgtId=', tgtId);
    if (!srcId)
      throw new Error(
        `流程引用了未声明的节点: "[${fe.srcLabel}]"。请确认该节点已在节点声明区定义，或它是合法的特殊节点`
      );
    if (!tgtId)
      throw new Error(
        `流程引用了未声明的节点: "[${fe.tgtLabel}]"。请确认该节点已在节点声明区定义，或它是合法的特殊节点`
      );
    edges.push({ id: eid(), src: srcId, tgt: tgtId, cond: fe.cond || '' });
  }

  // 强制入口节点为 (0,0)，因为 sketch 所有坐标以此为基准
  const entryNode = nodes.find(n => n.type === 'special' && (n.specialType === 'START' || n.specialType === 'IN'));
  if (entryNode) {
    entryNode.x = 0;
    entryNode.y = 0;
  }

  return { nodes, edges };
}


export { parsedToGraph, flowDeclsToGraph };
