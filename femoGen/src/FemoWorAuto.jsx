// ═══════════════════════════════════════════════════════════════
// ═══ FemoWorAuto.jsx ═══
// ═══════════════════════════════════════════════════════════════


import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  ErrorBoundary, FontStyle, TYPES, ti, SPECIAL_COLORS, SINK_ONLY,
  nid, eid, mid, NW, NH, MW, MH, SPW, SPH, PSW, PSH,
  getNodeSize, getSmartPorts, smartBezier, getControlPoints, bezierMidpoint,
  computeEdgeGeometry,
  findBackEdges, findAllCycleEdges, inp, btnP, btnS, Field,
  PortCircle, PR, makeDefaultNodes, getAllNames, applyForLinkage,
} from './common';
import { parseFEMO } from './femoParser';
import { warningsFromThrowable } from './femoDiagnostics';
import { buildFEMO } from './femoGenerator';
import { parsedToGraph } from './graphBuilder';
import { ActionNodeView, PositionNodeView, SpecialNodeView, ForOutNodeView, ParOutNodeView } from './canvasNodes';
import { LibPanel } from './libPanel';
import { ProjPanel } from './projectPanel';
import { ActionModal } from './actionModal';
import { SoulModal } from './soulModal';
import { FemoFileList } from './femoFileList';
import { BubbleOverlay } from './bubbleOverlay';
import { DebugPanel } from './debugPanel';
import { installFemoLogCapture, subscribeFemoLog, femoLogTail, clearFemoLog } from './femoLog';
import { FemoPreview } from './femoPreview';
import { MobileLayout, useMobile } from './mobileView';
import { FEMO_THEMES } from './themes';
import { FaPalette, FaUserPlus, FaTerminal, FaPlay, FaStop, FaForward, FaFolderOpen, FaFloppyDisk, FaSpinner } from './faIcons';

// 前端日志采集（2026-09-11）：模块加载即装钩子——femoGen 两种入口（插件内嵌经
// editor-page 引入本模块 / 独立 vite 经 main.jsx）都会走到这里，等于"页面一加载
// 就开始收"，启动阶段的 log 也不会漏。收来的行进调试面板『FEMOGen』页。
installFemoLogCapture();

// ═══ 工具栏芯片（2026-09-11 统一重造）═══
// 桌面右上角（运行控制 + 文件读写）一组成员的唯一施工图：同一高度/内边距/圆角/
// 字号/图标尺寸 + 短文案，**每枚都带 FA 图标**，只靠色调分语义——
//   绿=从头跑 / 红=停 / 琥珀=续跑 / 中性=文件读写（导入·导出）。
// 配方与底部三键（.femo-setting-btn 家族）同源：minHeight 30 芯片家族高度、
// gap 6、FA 图标 size 12、按压回缩反馈（hover 规则会被内联底色盖掉，同底部三键）。
// 与手机端 32×32 图标芯片同族（同图标、同语义色），桌面端多带文字标签。
const TOOL_CHIP_TONES = {
  success: { bg: 'var(--femo-success)', fg: 'var(--femo-on-accent)', border: 'var(--femo-success)' },
  danger: { bg: 'var(--femo-danger, #d24b4b)', fg: 'var(--femo-on-accent)', border: 'var(--femo-danger, #d24b4b)' },
  warning: { bg: 'var(--femo-surface)', fg: 'var(--femo-warning-strong, #dd8629)', border: 'var(--femo-warning-border, #f7ad31)' },
  neutral: { bg: 'var(--femo-surface)', fg: 'var(--femo-text-2)', border: 'var(--femo-border-strong)' },
};
function ToolChip({ icon: Icon, children, onClick, tone = 'neutral', title, disabled = false }) {
  const t = TOOL_CHIP_TONES[tone] || TOOL_CHIP_TONES.neutral;
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className="femo-setting-btn"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        height: 30, boxSizing: 'border-box',
        padding: '0 12px',
        borderRadius: 'var(--femo-radius-md)',
        border: `var(--femo-border-w-strong) solid ${t.border}`,
        background: t.bg,
        color: t.fg,
        fontSize: 11.5, fontWeight: 600,
        fontFamily: 'var(--femo-font-sans)',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap',
        transition: 'filter 0.12s, opacity 0.12s',
      }}
    >
      {Icon ? <Icon size={12} style={{ flexShrink: 0 }} /> : null}
      <span>{children}</span>
    </button>
  );
}

// ═══ 金线流光 v9（2026-08-24 彗星形态修正：强光在前、尾巴向后渐去）═══
// v8（round35 多层 dash 回撤）构造不变：流光=同一条路径的描边，六层长度递增(16→76px)、
// 透明度递减(1→0.04)、层叠圆帽抹平台阶。仅修正相位对齐方向——
// v8 负 delay 让长层【超前】(len-16)/2px → 亮核在后、淡尾伸向前方，与行进方向相反（猫猫报告）；
// v9 改为长层【滞后】len-16px（前端对齐）→ 亮核在前如彗头，尾巴向后渐淡。
// 滞后用相位环回表达（滞后 D ≡ 超前 288-D，cycle 均 288、速度 90px/s=femoEdgeSweep 288px/3.2s，
// 仍写负 delay 避免正 delay 的首帧空窗）：delay_i = -(288-(len_i-16))/90 s。
// 主题门控=.femo-edge-comet-layer CSS 不变（默认 opacity:0，dsh-dark/dsh 点亮）；语义边（红/琥珀）不调用本组件。
const SHIMMER_LAYERS = [
  { len: 16, op: 1,    delay: 0 },
  { len: 28, op: 0.5,  delay: -3.0667 },
  { len: 40, op: 0.28, delay: -2.9333 },
  { len: 52, op: 0.16, delay: -2.8 },
  { len: 64, op: 0.08, delay: -2.6667 },
  { len: 76, op: 0.04, delay: -2.5333 },
];
function EdgeShimmer({ d, w }) {
  return (
    <g className="femo-edge-comet" style={{ pointerEvents: 'none' }}>
      {SHIMMER_LAYERS.map((L, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="var(--femo-edge-sheen)"
          strokeLinecap="round"
          strokeOpacity={L.op}
          strokeWidth={w || 1}
          className="femo-edge-comet-layer"
          style={{ strokeDasharray: `${L.len} ${288 - L.len}`, animationDelay: `${L.delay}s` }}
        />
      ))}
    </g>
  );
}

// ═══ MAIN APP ═══
// ── 后端地址工具函数 ──
function getBackendHost() {
  try { return sessionStorage.getItem('femo_backend_host') || localStorage.getItem('femo_backend_host') || 'http://localhost'; } catch { return 'http://localhost'; }
}
function getBackendPort() {
  try { return sessionStorage.getItem('femo_backend_port') || '8000'; } catch { return '8000'; }
}
function getBackendBaseUrl() {
  const host = getBackendHost().replace(/\/+$/, '');
  const port = getBackendPort();
  return `${host}:${port}`;
}

// ── 零 token 调试干跑（2026-09-08）：DebugLogBus 记录 → 调试窗一行文本 ──
// Print 效果的格式化层：每条结构化记录渲染成一条可读流水；返回 null 的
// kind 不上屏（edge 高频噪音、flow_outcome 与 run_end 重复、正常收尾哨兵）。
function debugRecToLine(rec) {
  switch (rec.kind) {
    case 'run_start':
      return { level: 'info', kind: '调试', text: `▶ 第 ${rec.run ?? '-'} 轮干跑开始：${rec.script || '（未命名）'}${rec.module ? `（module ${rec.module}）` : ''}（seed=${rec.seed ?? '-'}）` };
    case 'node_start':
      return { level: 'info', kind: '调试', text: `→ ${rec.node}${rec.node_type ? `（${rec.node_type}）` : ''}` };
    case 'action_outs': {
      const exprs = (rec.exprs || []).join('，');
      if (!exprs) return null;
      return rec.node_type === 'func'
        ? { level: 'info', kind: '调试', text: `🔧 ${rec.node} 写回：${exprs}` }
        : { level: 'info', kind: '调试', text: `📝 ${rec.node} 赋值：${exprs}` };
    }
    case 'func_result': {
      const out = rec.output === null || rec.output === undefined ? ''
        : typeof rec.output === 'object' ? JSON.stringify(rec.output) : String(rec.output);
      if (!out) return null;
      let ins = '';
      try {
        const keys = Object.keys(rec.func_input || {});
        if (keys.length > 0) ins = `（入参 ${keys.map((k) => `${k}=${JSON.stringify(rec.func_input[k])}`).join('，')}）`;
      } catch { /* 入参渲染失败不拦结果行 */ }
      return { level: 'info', kind: '调试', text: `🔧 ${rec.node} 函数返回：${out.slice(0, 300)}${ins}` };
    }
    case 'assign':
      return { level: 'info', kind: '调试', text: `${rec.node}  ${rec.var}: ${rec.old} → ${rec.new}` };
    case 'ai_reply': {
      const entries = Object.entries(rec.values || {});
      if (entries.length === 0) return null;
      return { level: 'info', kind: '调试', text: `🤖 ${rec.node} 合成赋值：${entries.map(([k, v]) => `${k}=${v?.value}（${v?.source}）`).join('，')}` };
    }
    case 'human_input': {
      const parts = Object.entries(rec.variables || {}).map(([k, v]) => `${k}=${v}`);
      if (parts.length === 0) return null;
      return { level: 'info', kind: '调试', text: `👤 ${rec.node} 合成输入：${parts.join('，')}` };
    }
    case 'retry':
      return { level: 'warn', kind: '调试', text: `🔁 ${rec.node} 重试换值：${String(rec.feedback || '').slice(0, 160)}` };
    case 'silence':
      return { level: 'warn', kind: '调试', text: `🎲 ${rec.node} 概率沉默（不赋值 ${rec.var}）` };
    case 'flaky':
      return { level: 'warn', kind: '调试', text: `💥 ${rec.node} 注入无效赋值（测重试链路）` };
    case 'warning':
      return { level: 'warn', kind: '调试', text: `⚠ ${rec.msg || ''}` };
    case 'flow_outcome':
      return null;   // run_end 已带结局，不重复
    case 'run_end':
      return {
        // max_steps=跑满步数预算未停——可能是无限循环/持续循环型，非错误
        // （2026-09-12 口径）：warn 级不上红，模块单测里这是常见预期结局。
        level: rec.outcome === 'completed' ? 'info'
          : rec.outcome === 'max_steps' ? 'warn' : 'error',
        kind: '调试',
        text: `■ 第 ${rec.run ?? '-'} 轮结束：${rec.outcome}`
          + `${rec.outcome === 'max_steps' ? '（可能是无限循环，非错误）' : ''}`
          + `${rec.error ? ` — ${String(rec.error).slice(0, 200)}` : ''}（${rec.elapsed ?? '?'}s）`,
      };
    case 'debug_done':
      return null;   // 退出码语义=「是否全部轮 completed」，run_end 已如实呈现；
                     // 真崩溃（无任何 run_end）由 handleDebugRun 流内补报
    case 'debug_error':
      return { level: 'error', kind: '调试', text: String(rec.error || '') };
    default:
      return null;
  }
}

// 结构签名：只取拓扑相关字段做比较，忽略坐标 (x/y) 与瞬时态 (selected/dragging)——
// 用于判定「图是否被结构性修改」；拖动节点只改坐标不算修改。
function structuralSignature(nodes, edges) {
  const ns = (nodes || []).map((n) => {
    const c = { ...n };
    delete c.x; delete c.y; delete c.selected; delete c.dragging; delete c.width; delete c.height;
    return JSON.stringify(c);
  }).sort();
  const es = (edges || []).map((e) => {
    const c = { ...e };
    delete c.selected; delete c.dragging;
    return JSON.stringify(c);
  }).sort();
  return JSON.stringify({ ns, es });
}

// ── SSE 事件 → 调试窗口日志条目摘要（模块级纯函数）──
// 级别：error=剧本/引擎报错；warn=重试、警告等值得知情；info=常规运行信息。
// 返回单条 { level, text }、多条数组（compile_warnings 逐条一条目），
// 或 null（内部同步信号不喂日志，见尾部 skip 名单）。
function summarizeDebugEvent(type, data) {
  const d = data || {};
  const node = d.node_name ? `[${d.node_name}] ` : '';
  switch (type) {
    case 'flow_start':        return { level: 'info',  text: `${node}剧本开始运行` };
    case 'flow_done':         return { level: 'info',  text: '剧本运行完成' };
    case 'flow_stopped':      return { level: 'info',  text: '剧本已停止' };
    case 'flow_error':        return { level: 'error', text: `${node}${d.error || '未知错误'}` };
    case 'notify_author': {
      // 后端字段=severity（'fatal' | 'agent_error' | 'agent_giveup' | 'warning'）。
      // 旧代码读 d.level 永远落不中 → 作者通知（含真错误）全被降级 info，
      // 错误红标从不亮（2026-09-07 修正；d.level 留作兼容兜底）。
      const sev = d.severity || d.level;
      const lv = (sev === 'fatal' || sev === 'agent_error' || sev === 'agent_giveup') ? 'error'
        : (sev === 'warning' || sev === 'warn') ? 'warn' : 'info';
      return { level: lv, text: `${node}${d.message || '（作者通知）'}` };
    }
    case 'compile_warnings': {
      // 宿主在 job_start/job_resume 回执后广播的编译期警告（warning 桶）——
      // 编译放行了但作者应当知情，逐条一条目。
      const ws = Array.isArray(d.warnings) ? d.warnings : [];
      if (ws.length === 0) return null;
      return ws.map((w) => ({
        level: 'warn',
        text: `编译警告${w?.where ? `（${w.where}）` : ''}：${w?.message ?? ''}`,
      }));
    }
    case 'ai_retry':
      return {
        level: 'warn',
        text: `${node}AI 输出未过校验，第 ${d.attempt ?? '?'} 次重试：${
          Array.isArray(d.errors) ? d.errors.join('; ') : (d.errors || '')}`,
      };
    case 'bridge_run_ended':
      return d?.ok === false
        ? { level: 'error', text: '整场运行异常终止（ok=false）' }
        : { level: 'info',  text: '整场运行终止' };
    case 'node_start':        return { level: 'info',  text: `${node}节点开始` };
    case 'ai_done':           return { level: 'info',  text: `${node}AI 回答完成` };
    case 'human_wait':        return { level: 'info',  text: `${node}等待人类输入` };
    case 'human_done':        return { level: 'info',  text: `${node}人类输入已提交` };
    case 'node_retry':        return { level: 'warn',  text: `${node}${d.message || d.error || '节点重试'}` };
    case 'context_ready':     return { level: 'info',  text: `${node}上下文就绪` };
    case 'func_result':       return { level: 'info',  text: `${node}@func 返回` };
    case 'assign_result': {
      // 赋值完成条目带 out 变量最终值（引擎 assign_result.output = {变量: 赋值后值}）——
      // 值截断防长字符串刷屏；output 缺失（旧引擎帧）回落原文案。
      const outs = (d.output && typeof d.output === 'object' && !Array.isArray(d.output))
        ? Object.entries(d.output) : [];
      const fmtVal = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
      const tail = outs.length > 0
        ? `：${outs.map(([k, v]) => `${k} = ${String(fmtVal(v)).slice(0, 120)}`).join('；')}`
        : '';
      return { level: 'info', text: `${node}赋值完成${tail}` };
    }
    case 'notice_done':       return { level: 'info',  text: `${node}公告已注入` };
    case 'module_enter':      return { level: 'info',  text: `进入模块 ${d.module_name || '?'}` };
    case 'module_exit':       return { level: 'info',  text: `退出模块 ${d.module_name || '?'}` };
    case 'run_state':         return { level: d.state === 'failed' ? 'warn' : 'info', text: `运行状态 → ${d.state || '?'}` };
    case 'done':              return { level: 'info',  text: 'SSE 流结束' };
    // 引擎内部信号/状态同步帧：高频且无叙事价值，喂进日志只会刷屏淹没报错
    // （checkpoint 每节点一帧全量变量世界、projection_state 每次状态变化、
    // node_settled 停靠经纪人信号、script_changed 存稿同步）——不喂。
    case 'checkpoint':
    case 'node_settled':
    case 'projection_state':
    case 'script_changed':
      return null;
    default:
      return {
        level: 'info',
        text: node + (d.error || d.message || JSON.stringify(d).slice(0, 200)),
      };
  }
}

// 【追平帧判定（2026-09-11 v9）】两种"历史帧"标记同等对待：
//  - evt.replay：宿主 /dsh-femo/events 新连接重放环帧（信封顶层标记）；
//  - evt._replayed：画布尚未恢复时前端自己缓冲的补放帧。
// 追平帧只恢复状态（节点/断点/运行态），**绝不弹浮层**——浮层只由"此刻的
// 活事件"或 /session-state 权威快照触发。
const isCatchUpFrame = (evt) => evt?._replayed === true || evt?.replay === true;

// 引擎 checkpoint（{task_id: label}）→ 前端要高的那个节点的 label：
// 主流程 task 优先（__main__），否则任一分支（与 editor-page 的断点高亮同口径）。
const mainCheckpointLabel = (checkpoint) => {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const main = checkpoint['__main__'];
  if (typeof main === 'string' && main.length > 0) return main;
  const first = Object.values(checkpoint)[0];
  return typeof first === 'string' && first.length > 0 ? first : null;
};

const FEMOEditor = forwardRef(function FEMOEditor({ plugin = false, onRun, onStop, initialScript, initialCheckpoint, initialRunning = false, onExport, onImport, onListFemoFiles, onPickFemoFile, savedPath, onBackToShell, onRestoreError, onPersistScript, getRecordScript, sessionId = '', enginePending = false, initialJobId, jobIds, initialWaitingHuman, initialLastError } = {}, ref) {
// 插件模式：由 dsh-femo 注入（plugin=true）——运行/停止走插件回调，
// SSE 连插件广播路由；独立模式保留原后端调用（getBackendBaseUrl）。
// initialScript/initialCheckpoint/initialRunning：会话恢复（刷新/重启/运行中打开）。
// initialJobId/jobIds：宿主会话记录的 currentJobId + 激活过的全部 Job（2026-09-06
// job 快照改造）——停止/继续显式带号（镜像滞后也能停），jobIds 供历史场次 UI。
// initialLastError：上一个 failed Job 的存档错误（2026-09-10）——只进调试窗
// 日志（刷新/重开复见），不拦画布、不弹横幅。
// 【2026-09-07 B1 拆除】宿主侧 jobScriptMatches 预判退役：跑前草稿定版
// 由本组件 runGuard（未落盘修改弹窗）负责；改稿后续跑被拒由引擎指纹关
// 原话上浮——比对职责不再经过宿主。
// onPersistScript(femo)：定稿按钮（图生文本/文本生图）显式落盘会话记录；
// 2026-08-22 起不再有画布防抖自动回写，原文以用户输入为准。
// savedPath：会话剧本文件地址（导出/导入产生）——空=未保存（提示+绝对寻址）。
// onExport(femo, name)：导出（三态行为在 host 侧 editor-page 实现，返回 undefined=用户选了返回画布）；
// onImport()：导入=host 弹系统文件选择器→{path, content}（引用原始位置，2026-08-30），null=用户取消。
// onBackToShell：插件模式手机端返回键回调（dsh-femo 传 ctx.layout.toggleSidebar）。
// sessionId：本编辑器所属会话（Job 模型 §11.1：SSE 信封按 sid 过滤）。
// enginePending：引擎冷启动（bridge 未就绪）——按钮禁用+「引擎启动中」。
//console.log('✅ FEMOEditor 已进入渲染');
  // ── 主题：auto=跟随 dsh 本体（body[data-ds-dark-theme] 白天→dsh / 黑夜→dsh-dark），
  //    或手动固定 dsh / dsh-dark。localStorage 'femo_theme' 持久化，默认 auto。──
  const [themeSel, setThemeSel] = useState(() => {
    try {
      const saved = localStorage.getItem('femo_theme');
      return FEMO_THEMES.some((t) => t.id === saved) ? saved : 'auto';
    } catch { return 'auto'; }
  });
  // dsh 本体黑夜标记（布尔属性，必须 hasAttribute 检测；组件挂载时 body 必已存在）
  const [dsDark, setDsDark] = useState(() =>
    document.body?.hasAttribute('data-ds-dark-theme') ?? false
  );
  // 实时跟随：dsh 切白天/黑夜时 MutationObserver 感知 body 属性变化
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDsDark(document.body?.hasAttribute('data-ds-dark-theme') ?? false);
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    return () => obs.disconnect();
  }, []);
  const theme = themeSel === 'auto' ? (dsDark ? 'dsh-dark' : 'dsh') : themeSel;
  const cycleTheme = () => {
    const idx = FEMO_THEMES.findIndex((t) => t.id === themeSel);
    const next = FEMO_THEMES[(idx + 1) % FEMO_THEMES.length].id;
    setThemeSel(next);
    try { localStorage.setItem('femo_theme', next); } catch { /* ignore */ }
  };

  const [locationPath, setLocationPath] = useState(['mainflow']);
  const mode =
    locationPath.length === 1 && locationPath[0] === 'mainflow'
      ? 'mainflow'
      : 'module';
  const currentModuleName =
    locationPath.length > 1 ? locationPath[locationPath.length - 1] : null;

  const [nodes, setNodes] = useState(makeDefaultNodes('mainflow'));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [edges, setEdges] = useState([]);
  const edgesRef = useRef(edges);
  // 渲染期同步（2026-08-24 连接线丢失 bug 根因修复）：原 useEffect 异步同步使
  // edgesRef 落后一帧——恢复画布后 SSE flow_done 立即触发 saveAndNavigate 时，
  // nodesRef 已是新值而 edgesRef 还是 []，flowStore 被写入 {nodes:7, edges:[]}
  // 撕裂条目，E915 重载即丢全部连线。与上方 nodesRef 对称后，所有「保存当前
  // 画布」读点恒拿到同一渲染帧的一致快照。
  edgesRef.current = edges;

  // ---- 统一存储 ----
  const [actionStore, setActionStore] = useState([]); // { id, path, name, executorType, ... }
  const [moduleStore, setModuleStore] = useState([]); // { id, path, name, meta, code, nodes, edges }
  const [flowStore, setFlowStore] = useState([]); // { path, nodes, edges }

  const [sel, setSel] = useState(null);
  const [drag, setDrag] = useState(null);
  const [conn, setConn] = useState(null);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('library');
  const [proj, setProj] = useState({
    name: '新篇章-Neon',
    version: '1.0',
    owner: '1',
    database: 'chronica.wor',
    session: 'new',
    system_safety: '',
    output_style: '',
    code: [],
    actors: [],
  });

  // Canvas panning & zoom
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [rightPanelWidth, setRightPanelWidth] = useState(274);
  const [isResizingRight, setIsResizingRight] = useState(false);

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const mouseDownPos = useRef({ x: 0, y: 0 });
  const mouseDownPosRef = useRef({ x: 0, y: 0 });
  const isMouseDownRef = useRef(false);
  const isDraggingRef = useRef(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, px: 0, py: 0 });


  // ── 全局强制取消拖拽/连线/平移（单击任意位置时触发） ──
  const dragRef = useRef(drag);
  const connRef = useRef(conn);
  const isPanningRef = useRef(isPanning);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  useEffect(() => { connRef.current = conn; }, [conn]);
  useEffect(() => { isPanningRef.current = isPanning; }, [isPanning]);

  useEffect(() => {
    const handler = (e) => {
      if (dragRef.current || connRef.current || isPanningRef.current) {
        setDrag(null);
        setConn(null);
        setIsPanning(false);
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('mousedown', handler, true);
    return () => window.removeEventListener('mousedown', handler, true);
  }, []);

  // 移除 savedMainflow，改用 flowStore

  // FEMO preview editing
  const [femoText, setFemoText] = useState('');
  const [femoDirty, setFemoDirty] = useState(false);
  // 「图被修改」标记：只有结构性变更（增删节点/连线/改标签等）才算；
  // 拖动节点只改坐标不算。坐标由下次「图生文本」落进 #sketch。
  const [graphDirty, setGraphDirty] = useState(false);
  // 上次统一点（文本生图/图生文本/restore）的结构签名基线。
  const lastSyncedGraphRef = useRef('');
  // 运行守卫：存在未落盘修改时，先弹窗让用户选择定稿版本再运行。
  const [runGuard, setRunGuard] = useState(null);
  // 「放弃修改直接跑」的旁路开关（ref 同步生效，绕过旧闭包里尚未刷新的脏标志）。
  const skipRunGuardRef = useRef(false);
  const [lastValidFemo, setLastValidFemo] = useState('');
  const [femoError, setFemoError] = useState(null);
  // 非阻断警告（统一报错链路 warning 级）：可运行，黄条提醒。
  const [FEMOrnings, setFEMOrnings] = useState([]);

  // ═══ 调试窗口（2026-09-07 正式化）═══
  // 后端运行信息/报错的常驻日志流：新条目插最前，旧的被刷下去，上限 200 条
  // 自动淘汰最老——清空时机不用人操心。喂食点：SSE 事件（handleWorkflowEvent
  // 统一入口）、运行/停止/导出等本地生命周期、语法检查报错。
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLog, setDebugLog] = useState([]);   // [{ id, ts, level, kind, text }]，新在前
  const debugSeqRef = useRef(0);
  const pushDebug = useCallback((level, kind, text) => {
    setDebugLog((prev) => {
      const entry = {
        id: ++debugSeqRef.current,
        ts: Date.now(),
        level,
        kind,
        text: String(text ?? '').slice(0, 600),
      };
      const next = [entry, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });
  }, []);

  // ── 调试窗口『编译器』页（2026-09-11 用户点名）──────────────────────────
  // 后端编译器/引擎运行时 print 的原文。数据源：宿主 bridge 把引擎 stdout 的
  // 非 JSON 行逐行 pushDiag('engine', ...) 进 diag-feed → SSE femo_diag 实时
  // 广播；开面板时另拉 /dsh-femo/diag-tail 补历史（页面刷新后也有内容）。
  // 与『剧本』页完全分账：那边是画布事件/干跑流水（level 三态），这边是原样
  // 打印文本（无级别，故不上色）。
  const [compilerLog, setCompilerLog] = useState([]);   // [{ id, ts, text }]，新在前
  const compilerSeqRef = useRef(0);
  // 『Host』页同源同构（2026-09-11 用户点名）：宿主侧本插件代码的 console 输出，
  // 由 src/host-log.ts 钩 console 后进 diag feed 的 tag 'host'。两条流只是标签
  // 不同，入账逻辑共用一段，免得两处各写一份漂移。
  const [hostLog, setHostLog] = useState([]);
  const hostSeqRef = useRef(0);
  const appendDiagLine = useCallback((setList, seqRef, msg, ts) => {
    setList((prev) => {
      const entry = {
        id: ++seqRef.current,
        ts: Number.isFinite(ts) ? ts : Date.now(),
        text: String(msg ?? '').slice(0, 400),   // 与宿主侧截断口径一致
      };
      const next = [entry, ...prev];
      return next.length > 300 ? next.slice(0, 300) : next;
    });
  }, []);
  const pushCompilerLine = useCallback(
    (msg, ts) => appendDiagLine(setCompilerLog, compilerSeqRef, msg, ts),
    [appendDiagLine]
  );
  const pushHostLine = useCallback(
    (msg, ts) => appendDiagLine(setHostLog, hostSeqRef, msg, ts),
    [appendDiagLine]
  );
  // diag feed 里有 bridge/ev-in/human_wait… 多种标签：engine→『编译器』，
  // host→『Host』，其余（宿主排障面）不上这两页签。
  const handleDiagFeed = useCallback((d) => {
    if (!d) return;
    const ts = Date.parse(d.ts);
    if (d.tag === 'engine') pushCompilerLine(d.msg, ts);
    else if (d.tag === 'host') pushHostLine(d.msg, ts);
  }, [pushCompilerLine, pushHostLine]);
  // 开面板时补历史：SSE 只给"打开之后"的行，刷新页面/晚开面板会看着空。
  // 历史在前（倒序后与实时流同向：新在前），按 ts+文本去重后拼接。一次请求
  // 同时喂两条流（同一份 diag-tail 数据）。
  useEffect(() => {
    if (!debugOpen || !plugin) return undefined;   // 独立模式无宿主 diag 路由
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/dsh-femo/diag-tail?n=400');
        const data = await resp.json().catch(() => null);
        if (cancelled || !data || data.ok !== true || !Array.isArray(data.lines)) return;
        const seed = (setList, seqRef, tag) => {
          const rows = data.lines.filter((l) => l && l.tag === tag);
          if (rows.length === 0) return;
          setList((prev) => {
            const seen = new Set(prev.map((e) => `${e.ts}|${e.text}`));
            const hist = rows
              .map((l) => ({
                ts: Date.parse(l.ts) || Date.now(),
                text: String(l.msg ?? '').slice(0, 400),
              }))
              .filter((h) => !seen.has(`${h.ts}|${h.text}`));
            if (hist.length === 0) return prev;
            hist.reverse();   // 环内是时间正序 → 翻转成"新在前"，与实时流同向
            const next = [...hist.map((h) => ({ id: ++seqRef.current, ...h })), ...prev];
            return next.length > 300 ? next.slice(0, 300) : next;
          });
        };
        seed(setCompilerLog, compilerSeqRef, 'engine');
        seed(setHostLog, hostSeqRef, 'host');
      } catch { /* 拉不到历史不影响实时流（观测面绝不反噬主路） */ }
    })();
    return () => { cancelled = true; };
  }, [debugOpen, plugin]);

  // ── 调试窗口『FEMOGen』页（2026-09-11 用户点名）：前端 femoGen 自己的日志 ──
  // 采集在 femoLog.js（钩 console，模块级已 install），这里只订阅 + 首屏补历史。
  // 上限 400 与 femoLog 的环形缓冲一致；新行在前（batch 是时间正序，翻一下）。
  const [femogenLog, setFemogenLog] = useState(() => femoLogTail(200).slice().reverse());
  useEffect(() => subscribeFemoLog((batch) => {
    setFemogenLog((prev) => {
      const next = [...batch.slice().reverse(), ...prev];
      return next.length > 400 ? next.slice(0, 400) : next;
    });
  }), []);
  const clearFemogenLog = useCallback(() => {
    clearFemoLog();          // 连缓冲一起清，否则重开面板会把旧行补回来
    setFemogenLog([]);
  }, []);
  const [bubbleOverlay, setBubbleOverlay] = useState(null); // { nodeId }
  // 渲染期同步（与 nodesRef 同款）：事件处理里要读"浮层此刻开着没"来决定是否
  // 跟随运行（B 规则），不能用闭包里的旧值。
  const bubbleOverlayRef = useRef(bubbleOverlay);
  bubbleOverlayRef.current = bubbleOverlay;
  // par 并发下的人类等待（2026-09-07）：同一 mind 画布节点被 par 多实例并行
  // （AI+人类混合），所有实例事件同名 → 全写进同一个 nodeStates[nodeId]，
  // AI 实例的 node_start/ai_token 会把人类实例的 human_wait 状态整个冲掉，
  // 输入框「闪一下就被 AI 气泡取代」。humanWaits 是 AI 事件碰不到的独立账本
  // （nodeId → {wait_key,context,memory,showprompt,prompt,outVars,inputError}），
  // 人类输入面板由它驱动，常驻气泡顶端直到提交/本场结束。
  const [humanWaits, setHumanWaits] = useState({});
  const humanWaitsRef = useRef({});
  const setHumanWaitsBoth = useCallback((updater) => {
    setHumanWaits((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      humanWaitsRef.current = next;
      return next;
    });
  }, []);
  const [libSel, setLibSel] = useState(null); // { type: 'action'|'module', id }

  // 导出保存反馈（2026-09-06）：exportBusy=保存流程进行中（按钮禁用防重复
  // 提交）；exportToast={text, id}——保存成功的可见回执，显示落盘地址
  // （此前成功只有 console.log，用户无从判断是否保存成功）。
  const [exportBusy, setExportBusy] = useState(false);
  const [exportToast, setExportToast] = useState(null);
  const exportToastTimerRef = useRef(null);
  const showExportToast = useCallback((text) => {
    if (exportToastTimerRef.current) clearTimeout(exportToastTimerRef.current);
    setExportToast({ text, id: Date.now() });
    // 调试窗口留档：toast 4s 就消失，日志里常驻可查
    pushDebug('info', '导出', text);
    exportToastTimerRef.current = setTimeout(() => {
      setExportToast(null);
      exportToastTimerRef.current = null;
    }, 4000);
  }, [pushDebug]);

  // 停止反馈条（2026-09-07 214 事故收尾——停止链路静默吞错修复）：
  // stopNotice={level:'error'|'warning', text, id}——error=请求本身失败
  // （HTTP 错/超时/异常，动作被拒）；warning=请求受理但引擎未确认（8s 无
  // flow_stopped，或回执 state 已非 running=幂等无操作）。锚在工具栏右下方
  // （exportToast 上方一行），8s 自动消失。
  const [stopNotice, setStopNotice] = useState(null);
  const stopNoticeTimerRef = useRef(null);
  const stopConfirmTimerRef = useRef(null);   // 停止受理后的引擎确认计时器
  const showStopNotice = useCallback((level, text) => {
    if (stopNoticeTimerRef.current) clearTimeout(stopNoticeTimerRef.current);
    setStopNotice({ level, text, id: Date.now() });
    // 调试窗口留档：黄/红条 8s 就消失，日志里常驻可查
    pushDebug(level === 'error' ? 'error' : 'warn', '停止', text);
    stopNoticeTimerRef.current = setTimeout(() => {
      setStopNotice(null);
      stopNoticeTimerRef.current = null;
    }, 8000);
  }, [pushDebug]);
  // 引擎确认（flow_stopped / run_state 终态）到达即撤计时器——确认了就不提示。
  const clearStopConfirmTimer = useCallback(() => {
    if (stopConfirmTimerRef.current) {
      clearTimeout(stopConfirmTimerRef.current);
      stopConfirmTimerRef.current = null;
    }
  }, []);

  // Right panel resize logic
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingRight) return;
      // 2026-08-26 容器感知：右面板宽度=【编辑器容器右边缘】- 鼠标X。
      // 以前用 window.innerWidth 当"以为的屏幕"——内嵌在 dsh tab 里时
      // 容器右边缘 < 窗口右边缘，面板会被算宽、拖出容器右缘。
      const rootR = editorRootRef.current?.getBoundingClientRect();
      // 视口 px → 布局 px：面板 width 生活在 zoom 前的坐标系，不除 zoom 会
      // 以 75% 速度跟随拖拽（同类根因 2026-08-30 修正）
      const rz = effectiveZoom(editorRootRef.current, rootR || undefined);
      const newWidth = ((rootR ? rootR.right : window.innerWidth) - e.clientX) / rz;
      if (newWidth >= 200 && newWidth <= 500) {
        setRightPanelWidth(newWidth);
      }
    };
    const handleMouseUp = () => setIsResizingRight(false);

    if (isResizingRight) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingRight]);


  // ── 后端地址/连接状态 ──

  // ── 工作流运行状态 ──
  const [flowStatus, setFlowStatus] = useState('idle'); // idle | running | paused
  // 渲染期同步（与 nodesRef 同款）：SSE 帧处理/恢复补放等回调读它拿当帧值，
  // 不受闭包滞后影响（浮层弹出门卫 canPopOverlay 的依据）。
  const flowStatusRef = useRef(flowStatus);
  flowStatusRef.current = flowStatus;
  const [activeNodeIds, setActiveNodeIds] = useState(new Set()); // 当前正在运行的节点ID，用于呼吸灯效果
  const [errorNodeIds, setErrorNodeIds] = useState(new Set());

  // ── API Key 状态 ──
  const [userApiKey, setUserApiKey] = useState(() => {
    try { return localStorage.getItem('femo_user_api_key') || ''; } catch { return ''; }
  });
  const [userApiProvider, setUserApiProvider] = useState(() => {
    try { return localStorage.getItem('femo_user_api_provider') || 'mimo'; } catch { return 'mimo'; }
  });
const [userApiUrl, setUserApiUrl] = useState(() => {
  try { return localStorage.getItem('femo_user_api_url') || ''; } catch { return ''; }
});
const [userApiModel, setUserApiModel] = useState(() => {
  try { return localStorage.getItem('femo_user_api_model') || ''; } catch { return ''; }
});
  const [apiModelInput, setApiModelInput] = useState(userApiModel);
  const [runId, setRunId] = useState(null);
  // 插件模式当前 Job 号（2026-09-06 job 快照改造）：初值=宿主会话记录的
  // currentJobId，之后跟随 SSE 事件信封的 job_id 实时刷新（开跑/续跑/停止
  // 全覆盖）。停止/继续按钮显式带号——宿主内存镜像滞后/丢失（146 事故）
  // 也能正确停。
  const [pluginJobId, setPluginJobId] = useState(initialJobId ?? null);
  useEffect(() => {
    // session-state 重载（script_changed/切换回来）带来宿主侧最新指针；
    // 本地已在跑新 Job 时事件路径会再覆盖，两路最终一致。
    if (initialJobId !== undefined && initialJobId !== null) setPluginJobId(initialJobId);
  }, [initialJobId]);
  const [nodeStates, setNodeStates] = useState({}); // { [nodeId]: { status, streamingText, output, prompt, history } }
  const eventSourceRef = useRef(null);
  const humanInputResolveRef = useRef(null); // 用于人类输入的 Promise resolve
  // 本地最近一次运行控制操作（运行/停止/继续）时刻：SSE 接通时的快照校准
  // 在此窗口内跳过，防止校准把用户刚点出来的按钮态闪回去（见 connectSse）。
  const lastActionAtRef = useRef(0);


  // ── 新建 SOUL ID 浮层状态 ──
  const [soulModalOpen, setSoulModalOpen] = useState(false);
  const [soulForm, setSoulForm] = useState({ soul_id: '', soul_name: '', description: '' });
  const [soulFormError, setSoulFormError] = useState('');
  const [soulFormSubmitting, setSoulFormSubmitting] = useState(false);


  // Import file ref
  const fileInputRef = useRef(null);

  // ── 导入清单（导入的第一级，2026-09-11）──
  // 导入过/导出过的 .femo 历史，点「导入」先出这份清单；电脑端清单右上角
  // 另有「浏览…」走系统文件对话框（第二级）。手机端只有这一级——对话框开在
  // 电脑屏幕上，手机够不着。账本权威在 host 侧 src/femo-files.ts。
  const [femoFileOpen, setFemoFileOpen] = useState(false);
  const [femoFileList, setFemoFileList] = useState([]);
  const [femoFileLoading, setFemoFileLoading] = useState(false);
  const [femoFileError, setFemoFileError] = useState('');
  /** 正在打开的那条路径（行内「打开中…」+ 全表禁用防连点）。 */
  const [femoFileBusyPath, setFemoFileBusyPath] = useState(null);

  const cvRef = useRef(null);
  // 编辑器根容器（桌面分支外层 div）：内嵌 dsh tab 时「编辑器以为的屏幕」
  // 以它为准（2026-08-26 容器感知，右面板 resize 等）。
  const editorRootRef = useRef(null);

  // ═══ 运行时模块自动切换 ═══
  const moduleStackRef = useRef([]);            // 运行时模块栈
  const moduleStoreRef = useRef(moduleStore);   // 绕闭包，持有最新 moduleStore
  const locationPathRef = useRef(locationPath); // 绕闭包，持有最新 locationPath
  // 【刷新恢复（2026-09-06）】restoreDoneRef=画布已从会话快照恢复完（applyFEMOText
  // 跑过/无需跑）；恢复完成前 SSE 重放的节点事件在空画布上全部匹配不上会被
  // 丢弃——先入 pendingReplayRef 缓冲，恢复完成后按序补放，运行中小气泡才
  // 能在刷新后重建。
  const restoreDoneRef = useRef(false);
  const pendingReplayRef = useRef([]);
  const [canvasOpacity, setCanvasOpacity] = useState(1); // 淡入动效

  // 同步 ref
  useEffect(() => { moduleStoreRef.current = moduleStore; }, [moduleStore]);
  useEffect(() => { locationPathRef.current = locationPath; }, [locationPath]);

  // 辅助：根据路径查找模块（从 moduleStore）
  const findModuleByPath = useCallback(
    (path) => {
      if (path.length <= 1) return null;
      return moduleStore.find(
        (m) =>
          m.path &&
          m.path.length === path.length &&
          m.path.every((seg, i) => seg === path[i])
      );
    },
    [moduleStore]
  );

  // 辅助：从 actionStore 获取当前 locationPath 前缀匹配的 action 列表（祖先+自己）
  const visibleActions = useMemo(() => {
    return actionStore.filter((a) => {
      const ap = a.path || [];
      // 只显示当前层级及祖先层级的 Action（路径是 locationPath 的前缀，包括相等）
      if (ap.length > locationPath.length) return false;
      return ap.every((seg, i) => seg === locationPath[i]);
    });
  }, [actionStore, locationPath]);

  // 辅助：从 moduleStore 获取可见模块（祖先、自己、子模块、姊妹模块）
  const visibleModules = useMemo(() => {
    const anc = moduleStore.filter((m) => {
      const mp = m.path || [];
      return (
        mp.length < locationPath.length &&
        locationPath.every((seg, i) => seg === mp[i])
      );
    });
    const daughters = moduleStore.filter((m) => {
      const mp = m.path || [];
      return (
        mp.length === locationPath.length + 1 &&
        locationPath.every((seg, i) => seg === mp[i])
      );
    });
    const sisters = moduleStore.filter((m) => {
      const mp = m.path || [];
      if (mp.length !== locationPath.length) return false;
      if (mp.length === 0) return false;
      const motherSame = mp
        .slice(0, -1)
        .every((seg, i) => locationPath[i] === seg);
      const notSelf = !(
        mp.length === locationPath.length &&
        mp.every((seg, i) => seg === locationPath[i])
      );
      return motherSame && notSelf;
    });
    // 去重（理论上无重复）
    return [...new Set([...anc, ...daughters, ...sisters])];
  }, [moduleStore, locationPath]);

  // 兼容性 lib 对象，供现有代码使用（后续可逐步移除）
  const lib = useMemo(
    () => ({
      actions: visibleActions,
      modules: visibleModules,
    }),
    [visibleActions, visibleModules]
  );

  // 当前 flow 快照（用于生成 FEMO 或加载时）
  const currentFlow = useMemo(() => {
    return flowStore.find((f) => {
      const fp = f.path || [];
      return (
        fp.length === locationPath.length &&
        fp.every((seg, i) => seg === locationPath[i])
      );
    });
  }, [flowStore, locationPath]);

  // 旧的注释掉的 effect 已无必要，因为画布加载和保存将统一处理

  const flowStoreRef = useRef(flowStore);
  useEffect(() => { flowStoreRef.current = flowStore; }, [flowStore]);

  // 运行时模块切换：先保存当前画布，再切换 path，触发淡入
  const saveAndNavigateRef = useRef(null);
  saveAndNavigateRef.current = (targetPath) => {
    const currentPath = locationPathRef.current;
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    setFlowStore(prev => {
      const idx = prev.findIndex(
        f => f.path?.length === currentPath.length &&
             f.path?.every((s, i) => s === currentPath[i])
      );
      const entry = { path: [...currentPath], nodes: currentNodes, edges: currentEdges };
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = entry;
        return updated;
      }
      return [...prev, entry];
    });
    // 同值短路（2026-08-24 连接线丢失 bug 放大器修复）：flow_done/done/flow_stopped
    // 在主流程时 targetPath 与当前同值，但原写法每次传新数组实例 → locationPath
    // 引用必变 → E915 无谓重载画布（竞态窗口内会加载到坏条目）。同值时保持引用，
    // React bail out；路径真变时行为逐字节不变。
    setLocationPath((prev) =>
      prev.length === targetPath.length && prev.every((s, i) => s === targetPath[i])
        ? prev
        : targetPath
    );
    setCanvasOpacity(0);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setCanvasOpacity(1);
      });
    });
  };

  const nm = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const backEdges = useMemo(() => {
    // console.log('[backEdges] useMemo 重算, nodes:', nodes.length, 'edges:', edges.length);
    return findBackEdges(nodes, edges);
  }, [nodes, edges]);

  const actionMap = useMemo(() => {
    const map = new Map();
    actionStore.forEach(a => map.set(a.id, a));
    return map;
  }, [actionStore]);

  const sortedEdges = useMemo(() => {
    const forOutNodeIds = new Set(
      nodes.filter(n => n.type === 'for_out' || n.type === 'par_out').map(n => n.id)
    );
    const hasForOut = (edge) => forOutNodeIds.has(edge.src) || forOutNodeIds.has(edge.tgt);
    const normal = [];
    const forOutEdges = [];
    for (const e of edges) {
      if (hasForOut(e)) {
        forOutEdges.push(e);
      } else {
        normal.push(e);
      }
    }
    return [...normal, ...forOutEdges];
  }, [edges, nodes]);

  // [femo-diag] 渲染期端点缺失计数：>0 = 有边因 nm 查不到节点被静默 return null
  const diagMissingEdgeCount = useMemo(
    () => sortedEdges.reduce((acc, e) => (nm.get(e.src) && nm.get(e.tgt) ? acc : acc + 1), 0),
    [sortedEdges, nm]
  );
  useEffect(() => {
    if (diagMissingEdgeCount > 0) {
      console.log('[femo-diag] RENDER-DROP edges-with-missing-endpoints=' + diagMissingEdgeCount + ' / total=' + sortedEdges.length + ' nodes=' + nodes.length);
    }
  }, [diagMissingEdgeCount, sortedEdges.length, nodes.length]);


  // 按 FOR 节点分组的环边映射
  const cycleEdgesMap = useMemo(() => findAllCycleEdges(nodes, edges), [nodes, edges]);

  // 所有环边的全局集合（包含 FOR 和 PAR）
  const allCycleEdges = useMemo(() => {
    const all = new Set();
    for (const edgeSet of cycleEdgesMap.values()) {
      for (const eid of edgeSet) all.add(eid);
    }
    return all;
  }, [cycleEdgesMap]);
 

  // 检测从 FOR 节点出发但未形成回环的边（红色虚线）
  const forBrokenEdges = useMemo(() => {
    const broken = new Set();
    const adj = new Map();
    edges.forEach((e) => {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src).push(e);
    });
    const forNodeIds = new Set(
      nodes.filter(n => n.specialType === 'FOR').map(n => n.id)
    );
    const outNodeIds = new Set(
      nodes.filter(n => n.type === 'for_out' || n.type === 'par_out').map(n => n.id)
    );
    for (const startId of forNodeIds) {
      const stack = [startId];
      const localVisited = new Set();
      while (stack.length) {
        const cur = stack.pop();
        for (const e of adj.get(cur) || []) {
          if (localVisited.has(e.id)) continue;
          localVisited.add(e.id);
          if (outNodeIds.has(e.src) || outNodeIds.has(e.tgt)) continue;
          if (allCycleEdges.has(e.id)) continue;
          if (forNodeIds.has(e.tgt)) continue;
          broken.add(e.id);
          stack.push(e.tgt);
        }
      }
    }
    return broken;
  }, [nodes, edges, allCycleEdges]);


  // ── PAR 相关计算 ──
  const parNodeIds = useMemo(() => 
    new Set(nodes.filter(n => n.specialType === 'PAR').map(n => n.id)), 
    [nodes]
  );

// PAR 节点与其 par_out 节点的映射
const parOutNodeMap = useMemo(() => {
    const map = new Map();
    nodes.forEach(n => {
      if (n.type === 'par_out' && n.forNodeId) {
        map.set(n.forNodeId, n.id);
      }
    });
    return map;
  }, [nodes]);

  // PAR 有效边（蓝实线）：从 PAR 主节点出发，到达其对应 par_out 节点的路径上的边（不包括 par_out 出发的边）
  const parCycleEdges = useMemo(() => {
    const valid = new Set();
    const adj = new Map();
    edges.forEach(e => {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src).push(e);
    });
    const nmLocal = new Map(nodes.map(n => [n.id, n])); // O(1) 查找替代 nodes.find
    //console.log('[parCycleEdges] 开始计算, parNodeIds:', [...parNodeIds]);
    for (const parId of parNodeIds) {
      const targetOutId = parOutNodeMap.get(parId);
      if (!targetOutId) { console.warn('[parCycleEdges] PAR节点', parId, '无对应 par_out, 跳过'); continue; }
      const visitedEdges = new Set();
      const path = [];
      const recStack = new Set(); // 防止非目标子环无限递归
      function dfs(curId) {
        if (recStack.has(curId)) {
          //console.log('[parCycleEdges] recStack 命中入口, 节点:', curId, 'parId:', parId, '停止深入');
          return;
        }
        recStack.add(curId);
        if (curId === targetOutId) {
          path.forEach(eid => valid.add(eid));
          //console.log('[parCycleEdges] PAR', parId, '节点直接到达 par_out, 收集路径边数:', path.length);
          recStack.delete(curId);
          return;
        }
        // 不进入 par_out 节点
        if (nmLocal.get(curId)?.type === 'par_out') { recStack.delete(curId); return; }
        for (const e of (adj.get(curId) || [])) {
          if (visitedEdges.has(e.id)) continue;
          visitedEdges.add(e.id);
          path.push(e.id);
          if (e.tgt === targetOutId) {
            // 边直接到达 par_out
            path.forEach(eid => valid.add(eid));
            //console.log('[parCycleEdges] 边到达 par_out, parId:', parId, 'curId:', curId, 'e.id:', e.id, '收集路径边数:', path.length, '累计:', valid.size);
          } else if (recStack.has(e.tgt)) {
            // ★ 回指上游节点：收录当前路径所有边（含此回指边），不递归
            //console.log('[parCycleEdges] 回指边收录, parId:', parId, 'curId:', curId, 'e.id:', e.id, 'e.tgt:', e.tgt, 'path:', [...path], '累计:', valid.size);
            path.forEach(eid => valid.add(eid));
          } else {
            dfs(e.tgt);
          }
          path.pop();
          visitedEdges.delete(e.id);
        }
        recStack.delete(curId);
      }
      dfs(parId);
    }
    //console.log('[parCycleEdges] 计算完成, 有效边数:', valid.size);
    return valid;
  }, [nodes, edges, parNodeIds, parOutNodeMap]);

  // PAR 无效边（红虚线）：从 PAR 主节点出发，未到达 par_out 的边（同样不进入 par_out 继续）
  const parBrokenEdges = useMemo(() => {
    const broken = new Set();
    const adj = new Map();
    edges.forEach(e => {
      if (!adj.has(e.src)) adj.set(e.src, []);
      adj.get(e.src).push(e);
    });
    for (const parId of parNodeIds) {
      const targetOutId = parOutNodeMap.get(parId);
      if (!targetOutId) continue;
      const visited = new Set();
      const stack = [parId];
      while (stack.length) {
        const cur = stack.pop();
        // 遇到 par_out 节点不再继续
        if (nodes.find(n => n.id === cur)?.type === 'par_out') continue;
        for (const e of (adj.get(cur) || [])) {
          if (visited.has(e.id)) continue;
          visited.add(e.id);
          if (!parCycleEdges.has(e.id)) {
            broken.add(e.id);
          }
          stack.push(e.tgt);
        }
      }
    }
    return broken;
  }, [nodes, edges, parCycleEdges, parNodeIds, parOutNodeMap]);

  // 删除 parCycleEdgesMap，后续代码中如果有引用它的地方（如循环显示）请改为直接使用 parCycleEdges
  // 如果没有其他引用，可直接移除。

  // ── 连线端点偏移分组 ──
  const portEdgeGroupMap = useMemo(() => {
    // key: `${nodeId}:${dir}`, value: { edges: string[], indices: { [edgeId]: number } }
    const groups = {};
    edges.forEach(e => {
      const s = nm.get(e.src), t = nm.get(e.tgt);
      if (!s || !t) return;
      if (e.src === e.tgt) return; // 自环不参与
      const isCycle = allCycleEdges.has(e.id);
      const { srcDir, tgtDir } = getSmartPorts(s, t, isCycle);
      // 排除 for_out 节点
      const srcKey = (s.type === 'for_out' || s.type === 'par_out') ? null : `${e.src}:${srcDir}`;
      const tgtKey = (t.type === 'for_out' || t.type === 'par_out') ? null : `${e.tgt}:${tgtDir}`;
      if (srcKey) {
        if (!groups[srcKey]) groups[srcKey] = [];
        groups[srcKey].push(e.id);
      }
      if (tgtKey) {
        if (!groups[tgtKey]) groups[tgtKey] = [];
        groups[tgtKey].push(e.id);
      }
    });
    // 对每组排序，构建索引映射
    const result = {};
    for (const key in groups) {
      const edgeIds = groups[key].sort(); // 按 ID 稳定排序
      const indices = {};
      edgeIds.forEach((id, idx) => { indices[id] = idx; });
      result[key] = { edgeIds, indices, count: edgeIds.length };
    }
    return result;
  }, [edges, nodes, allCycleEdges, nm]);

  // 判断当前是否有真正在运行的节点（非完成/错误）
  const hasActiveRunningNodes = useMemo(() => {
    if (flowStatus !== 'running') return false;
    for (const id of activeNodeIds) {
      const status = nodeStates[id]?.status;
      if (status && !['ai_done', 'human_done', 'done', 'error'].includes(status)) {
        return true;
      }
    }
    return false;
  }, [flowStatus, activeNodeIds, nodeStates]);

  // All names for uniqueness check
  const allNames = useMemo(() => {
    const names = new Set();
    actionStore.forEach((a) => names.add(a.name));
    moduleStore.forEach((m) => names.add(m.name));
    (proj.actors || []).forEach((a) => {
      const n = a.name?.replace('@', '');
      if (n) names.add(n);
    });
    return names;
  }, [actionStore, moduleStore, proj]);

  // ═══ 已停用：autoFemo 实时计算 ═══
  // 原因：
  // 1. 每次 nodes/edges 变化（拖拽一像素）都触发 buildFEMO（含双DFS+全量序列化），性能灾难
  // 2. femoDirty 一旦被意外激活，后续所有画布操作都不刷新 FEMO 文本
  // 3. onSave 末尾的 setFemoDirty(false) 与 React 批量更新形成竞态
  // 改为：用户点 [图到文本] 按钮或运行/导出时，调用 handleGraphToFemo()
  //
  // const autoFemo = useMemo(() => {
  //   try {
  //     const flowMap = new Map();
  //     flowStore.forEach((f) => flowMap.set(f.path.join('/'), f));
  //     flowMap.set(locationPath.join('/'), { path: locationPath, nodes, edges });
  //     const mainFlow = flowMap.get('mainflow');
  //     const mainNodes = mainFlow ? mainFlow.nodes : makeDefaultNodes('mainflow');
  //     const mainEdges = mainFlow ? mainFlow.edges : [];
  //     const mergedModules = moduleStore.map((mod) => {
  //       const key = mod.path.join('/');
  //       const flow = flowMap.get(key);
  //       return flow ? { ...mod, nodes: flow.nodes, edges: flow.edges } : mod;
  //     });
  //     return buildFEMO(mainNodes, mainEdges, proj, mode, currentModuleName, mergedModules, actionStore);
  //   } catch (e) {
  //     console.error('autoFemo 生成失败:', e);
  //     return '# 生成 FEMO 时出错，请检查控制台';
  //   }
  // }, [nodes, edges, locationPath, proj, mode, currentModuleName, moduleStore, actionStore, flowStore]);
  //
  // useEffect(() => {
  //   if (!femoDirty) {
  //     setFemoText(autoFemo);
  //     setLastValidFemo(autoFemo);
  //     setFemoError(null);
  //   }
  // }, [autoFemo, femoDirty]);

  // 读取元素实际生效的 CSS zoom（插件模式编辑器根节点 zoom:0.75，L~2764）。
  // getBoundingClientRect 与 e.clientX 都是视口坐标（已含 zoom），而节点坐标、
  // pan、面板宽度都生活在 zoom 前的布局坐标系——鼠标换算前必须除掉该系数，
  // 否则所有交互都按 75% 偏移（连线终点不跟手、拖节点/平移变慢，2026-08-30
  // 猫猫截图实锤：终点恰好停在真实 offset 的 75% 处）。
  // currentCSSZoom（Chromium 128+）优先；rect.width/offsetWidth 比例兜底。
  function effectiveZoom(el, rect) {
    if (!el) return 1;
    const z = el.currentCSSZoom;
    if (typeof z === 'number' && isFinite(z) && z > 0) return z;
    const r = rect || el.getBoundingClientRect();
    return r.width && el.offsetWidth ? r.width / el.offsetWidth : 1;
  }

  // Coordinate conversion (accounting for pan + ancestor CSS zoom)
  const xy = useCallback(
    (e) => {
      const r = cvRef.current?.getBoundingClientRect();
      if (!r) return [0, 0];
      const z = effectiveZoom(cvRef.current, r);
      return [
        ((e.clientX - r.left) / z - pan.x) / scale,
        ((e.clientY - r.top) / z - pan.y) / scale,
      ];
    },
    [pan, scale]
  );

  // ── 画布状态持久化 ──
  const saveToLocalStorage = useCallback(() => {
    try {
      const updatedFlowStore = [...flowStore];
      const idx = updatedFlowStore.findIndex(
        (f) =>
          f.path?.length === locationPath.length &&
          f.path?.every((s, i) => s === locationPath[i])
      );
      const entry = {
        path: [...locationPath],
        nodes: nodesRef.current,
        edges: edgesRef.current,
      };
      if (idx >= 0) {
        updatedFlowStore[idx] = entry;
      } else {
        updatedFlowStore.push(entry);
      }
      const state = {
        nodes: nodesRef.current,
        edges: edgesRef.current,
        flowStore: updatedFlowStore,
        locationPath,
        actionStore,
        moduleStore,
        proj,
      };
      localStorage.setItem('femo_editor_state', JSON.stringify(state));
      const currentFlow = updatedFlowStore.find(f => f.path.join('/') === locationPath.join('/'));
      const entryNode = currentFlow?.nodes?.find(n => n.specialType === 'START' || n.specialType === 'IN');
      //console.log('[DEBUG] saveToLocalStorage 入口坐标:', entryNode?.x, entryNode?.y, '当前路径:', locationPath.join('/'));
    } catch (e) {
      console.warn('保存画布状态失败:', e);
    }
  }, [locationPath, actionStore, moduleStore, proj, flowStore]);

  // 当状态变化时自动保存（防抖延迟）
  useEffect(() => {
    const timer = setTimeout(() => {
      saveToLocalStorage();
    }, 10);
    return () => clearTimeout(timer);
  }, [saveToLocalStorage]);

  // 2026-08-22 架构重构：插件模式不再自动把画布回写成文本。
  // 原行为 = 任何画布变化 3s 后经 buildFEMO 全量重生成并覆盖 record，
  // 是「打开看一眼就污染原文」的元凶。现在统一只走两个定稿按钮：
  // 文本生图（handleApplyFemo）/ 图生文本（handleGraphToTextCommit）。

  // 图修改检测：与上次统一点的结构基线比较（忽略坐标），漂移即置脏。
  useEffect(() => {
    if (!plugin) return;
    if (!lastSyncedGraphRef.current) return; // 尚未 restore，无基线
    setGraphDirty(structuralSignature(nodes, edges) !== lastSyncedGraphRef.current);
  }, [plugin, nodes, edges]);

  // 初始化时加载状态（插件模式跳过：画布状态按会话快照恢复，不读 localStorage）
  useEffect(() => {
    if (plugin) return;
    try {
      const saved = localStorage.getItem('femo_editor_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        //console.log('[DEBUG] 从 localStorage 恢复的数据：');
        const flow = parsed.flowStore?.find(f => f.path?.join?.('/') === parsed.locationPath?.join?.('/'));
        const entryNode = flow?.nodes?.find(n => n.specialType === 'START' || n.specialType === 'IN');
        //console.log('[DEBUG] 恢复的入口坐标:', entryNode?.x, entryNode?.y, '路径:', parsed.locationPath?.join?.('/'));

        if (parsed.nodes) setNodes(parsed.nodes);
        if (parsed.edges) setEdges(parsed.edges);
        if (parsed.flowStore) setFlowStore(parsed.flowStore);
        if (parsed.locationPath) setLocationPath(parsed.locationPath);
        if (parsed.actionStore) setActionStore(parsed.actionStore);
        if (parsed.moduleStore) setModuleStore(parsed.moduleStore);
        if (parsed.proj) setProj(parsed.proj);
      }
    } catch (e) {
      console.warn('加载画布状态失败:', e);
    }
  }, []); // 仅挂载时运行一次

  // 插件模式会话恢复：剧本快照 → 文本到图加载画布 + 代码框；断点 → 「继续」+ 高亮。
  // 依赖 props（session-state 异步返回后才会触发），且 props 稳定后只执行一次。
  useEffect(() => {
    if (!plugin) return;
    // [femo-diag] 恢复触发器：undefined=会话无剧本记录；空串=记录异常
    try { console.log('[femo-diag] restore-effect script=' + (initialScript === undefined ? 'undefined' : String(initialScript.length)) + 'ch running=' + String(initialRunning) + ' ckpt=' + String(initialCheckpoint ?? 'none')); } catch {}
    if (initialScript && initialScript.trim().length > 0) {
      try {
        applyFEMOText(initialScript);
        setFemoText(initialScript);
        console.log('[FEMOEditor] 已从会话快照恢复画布, 长度:', initialScript.length);
      } catch (e) {
        console.warn('[FEMOEditor] 会话快照恢复失败:', e);
        // 不再静默：画布面板可见 + 上抛给插件层（回传主模型）。
        // 2026-08-26：解析失败的坏剧本也把【原文】载入输入框（画布留空）——
        //  ①人类能就地改文本修复；②AI 触发 run 时 handleRunWorkflow 的
        //  parseFEMO 会拿真实错误回传（而不是「请先编写或导入 FEMO 脚本」）。
        const msg = e instanceof Error ? e.message : String(e);
        setFemoText(initialScript);
        setFemoError(`会话快照恢复失败：${msg}`);
        setFEMOrnings(warningsFromThrowable(e));
        pushDebug('error', '恢复', `会话快照恢复失败：${msg}`);
        if (typeof onRestoreError === 'function') onRestoreError(msg);
      } finally {
        // 无论成败：恢复阶段结束，SSE 重放缓冲此后放行（不再入队）。
        restoreDoneRef.current = true;
      }
    } else {
      // 无剧本：无可恢复画布，恢复视为完成（缓冲事件直接放行）。
      restoreDoneRef.current = true;
    }
    if (initialCheckpoint) {
      setFlowStatus('paused'); // 按钮显示「继续」= 断点续跑（host 代理的
      // checkpoint 已是引擎裁决产物——Job suspended 才有断点，B2 修复：
      // 前端不再给"必假继续"）
    }
    if (initialRunning) {
      // 会话已在运行（比如对话窗先启动的）：立即接入实时流，按钮显示运行态。
      setFlowStatus('running');
      connectSse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, initialScript, initialCheckpoint, initialRunning]);

  // 【上次运行报错留档（2026-09-10）】存档里的 failed 错误只进调试窗日志：
  // 画布恢复不再被报错拦路（宿主侧已修），错误以一行日志形态可查——刷新/
  // 重开复见，宿主重启后 SSE 重放环清空时这里是唯一来源；开新一轮即被
  // 新场次的档案覆盖，不常驻。
  const lastErrorSeenRef = useRef(null);
  useEffect(() => {
    if (!plugin || !initialLastError) return;
    if (lastErrorSeenRef.current === initialLastError) return;
    lastErrorSeenRef.current = initialLastError;
    pushDebug('error', '恢复', `上次运行报错（Job ${initialJobId ?? '-'}）：${initialLastError}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, initialLastError]);

  // 断点高亮：画布恢复（applyFEMOText 异步 setState）完成后按 label 匹配节点。
  // 【D1 修复 §11.3】宿主 /session-state 已把引擎 checkpoint 翻译成 label 形态
  // （checkpoint_labels）；这里双形态兜底（label 相等 或 [label] 相等——
  // 存量记录兼容），不再恒 false。
  useEffect(() => {
    if (!plugin || !initialCheckpoint) return;
    const target = (nodes || []).find((n) =>
      n.label === initialCheckpoint || '[' + n.label + ']' === initialCheckpoint);
    if (target) setActiveNodeIds(new Set([target.id]));
  }, [plugin, initialCheckpoint, nodes]);

  // Space key for panning
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (
        e.code === 'Space' &&
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const handleKeyUp = (e) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // 全局禁止画布外的缩放（滚轮、手势、键盘）
  useEffect(() => {
    const handleGlobalWheel = (e) => {
      // 画布内的所有 wheel 事件：全面阻止浏览器默认行为（横向滑动、返回手势、缩放等）
      if (cvRef.current?.contains(e.target)) {
        e.preventDefault();
        return;
      }
      // 画布外：仅禁止 Ctrl / ⌘ 缩放
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    document.addEventListener('wheel', handleGlobalWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handleGlobalWheel, { capture: true });
  }, []);


  useEffect(() => {
    // 禁止移动端手势缩放（画布外）
    const handleGesture = (e) => {
      if (!cvRef.current?.contains(e.target)) {
        e.preventDefault();
      }
    };
    document.addEventListener('gesturestart', handleGesture);
    document.addEventListener('gesturechange', handleGesture);
    document.addEventListener('gestureend', handleGesture);
    return () => {
      document.removeEventListener('gesturestart', handleGesture);
      document.removeEventListener('gesturechange', handleGesture);
      document.removeEventListener('gestureend', handleGesture);
    };
  }, []);

  useEffect(() => {
    // 禁止 Ctrl/⌘ + 滚轮 及 Ctrl/⌘ + +/-/0 缩放（输入框内除外）
    const handleKeyZoom = (e) => {
      if (e.ctrlKey || e.metaKey) {
        const key = e.key;
        if (key === '-' || key === '+' || key === '=' || key === '0') {
          const tag = e.target.tagName;
          if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !e.target.isContentEditable) {
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyZoom, { passive: false, capture: true });
    return () => window.removeEventListener('keydown', handleKeyZoom, { capture: true });
  }, []);

  // Delete key handler
  useEffect(() => {
    const h = (e) => {
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        sel &&
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'TEXTAREA'
      ) {
          if (sel.type === 'node') {
            const node = nm.get(sel.id);
            if (node?.type === 'special') {
              const isMandatory = node.specialType === 'START' || node.specialType === 'IN';
              const sameTypeNodes = nodes.filter(n => n.type === 'special' && n.specialType === node.specialType);
              const isOnlyExit = (node.specialType === 'END' || node.specialType === 'OUT') && sameTypeNodes.length <= 1;
              if (isMandatory || isOnlyExit) return;
            }
            deleteNode(sel.id);
          } else {
            setEdges((p) => p.filter((e) => e.id !== sel.id));
            setSel(null);
          }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, nodes]);

  // 当 locationPath 变化时，加载新路径的画布（只依赖 locationPath）
  useEffect(() => {
    const currentFlowStore = flowStoreRef.current;
    const flow = currentFlowStore.find(
      (f) =>
        f.path?.length === locationPath.length &&
        f.path?.every((s, i) => s === locationPath[i])
    );
    if (flow) {
      // [femo-diag] 路径切换加载 flowStore：若此处 edges=0 而 applyFEMOText 曾给出 >0，
      // 即「恢复后被空/陈旧 flowStore 条目覆盖」的直接证据（连接线丢失调查）。
      try { console.log('[femo-diag] locpath-load path=' + locationPath.join('/') + ' nodes=' + (flow.nodes || []).length + ' edges=' + (flow.edges || []).length); } catch {}
      setNodes(flow.nodes || []);
      setEdges(flow.edges || []);
    } else {
      // 没有缓存，创建默认节点
      if (locationPath.length === 1 && locationPath[0] === 'mainflow') {
        setNodes(makeDefaultNodes('mainflow'));
        setEdges([]);
      } else {
        setNodes(makeDefaultNodes('module'));
        setEdges([]);
      }
    }
  }, [locationPath]); // 不再依赖 flowStore，避免实时同步覆盖用户操作

  // Add action node to canvas
  function addNode(action, x, y) {
    const n = nodes.length;
    const id = nid();
    // 生成唯一节点标签
    const base = action.name;
    const existingLabels = new Set(nodes.map((node) => node.label));
    let label = `[${base}]`;
    if (existingLabels.has(label)) {
      let cnt = 2;
      while (existingLabels.has(`[${base}_${cnt}]`)) cnt++;
      label = `[${base}_${cnt}]`;
    }
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'action',
        actionId: action.id,
        x: x ?? 180 + (n % 3) * 240,
        y: y ?? 120 + Math.floor(n / 3) * 140,
        label,
      },
    ]);
  }

  // Add module node to canvas
  function addModuleNode(mod, x, y) {
    const n = nodes.length;
    const id = nid();
    // 生成唯一节点标签
    const base = mod.name;
    const existingLabels = new Set(nodes.map((node) => node.label));
    let label = `[${base}]`;
    if (existingLabels.has(label)) {
      let cnt = 2;
      while (existingLabels.has(`[${base}_${cnt}]`)) cnt++;
      label = `[${base}_${cnt}]`;
    }
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'module',
        modRef: mod.name,
        modDef: mod,
        x: x ?? 180 + (n % 3) * 260,
        y: y ?? 120 + Math.floor(n / 3) * 150,
        label,
      },
    ]);
  }

  // Add special node to canvas
  function addSpecialNode(specialType, x, y) {
    if (specialType === 'START' || specialType === 'IN') {
      if (nodes.some((n) => n.type === 'special' && n.specialType === specialType)) return;
    }
    const n = nodes.filter((nd) => nd.type === 'special' && nd.specialType === specialType).length;
    const id = nid();
    const label = n > 0 ? `[${specialType}_${n + 1}]` : `[${specialType}]`;
    const nodeX = x ?? 600;
    const nodeY = y ?? 200 + n * 80;

if (specialType === 'FOR') {
  const outId = nid();
  const outLabel = `${label}_出`;
  const outX = nodeX + SPW - 22;
  const outY = nodeY + (SPH - 22) / 2;
  setNodes((p) => [
    ...p,
    {
      id,
      type: 'special',
      specialType,
      x: nodeX,
      y: nodeY,
      label,
      forOutNodeId: outId,
      forCondition: '',
    },
    {
      id: outId,
      type: 'for_out',
      specialType: 'FOR_OUT',
      x: outX,
      y: outY,
      label: outLabel,
      forNodeId: id,
    },
  ]);
  } else if (specialType === 'PAR') {
    // 保证 label 唯一（考虑画布上已存在各种 label 的情况）
    const existingLabels = new Set(nodes.map((n) => n.label));
    let baseLabel = `[PAR]`;
    let candidateLabel = baseLabel;
    let counter = 2;
    while (existingLabels.has(candidateLabel)) {
      candidateLabel = `[PAR_${counter}]`;
      counter++;
    }
    const finalLabel = candidateLabel; // 例： [PAR_2]
    const baseName = finalLabel.slice(1, -1); // 去掉 [] 得到 PAR_2
    const outId = nid();
    const outLabel = `[${baseName}_出]`;
    const outX = nodeX + 220;
    const outY = nodeY;
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'special',
        specialType: 'PAR',
        x: nodeX,
        y: nodeY,
        label: finalLabel,
        forOutNodeId: outId,
        forCondition: '',
      },
      {
        id: outId,
        type: 'par_out',
        specialType: 'PAR_OUT',
        x: outX,
        y: outY,
        label: outLabel,
        forNodeId: id,
      },
    ]);
  } else {
      setNodes((p) => [
        ...p,
        {
          id,
          type: 'special',
          specialType,
          x: nodeX,
          y: nodeY,
          label,
        },
      ]);
    }
  }

  // Add position node to canvas
  function addPositionNode(x, y) {
    const existingLabels = new Set(nodes.map(n => n.label));
    let base = 'pos';
    let counter = 1;
    let label = `[${base}_${counter}]`;
    while (existingLabels.has(label)) {
      counter++;
      label = `[${base}_${counter}]`;
    }
    const id = nid();
    setNodes((p) => [
      ...p,
      {
        id,
        type: 'position',
        x: x ?? 300,
        y: y ?? 150,
        label,
      },
    ]);
  }

  const deleteNode = useCallback((nodeId) => {
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node) return;
    const idsToDelete = new Set([nodeId]);
    if ((node.specialType === 'FOR' || node.specialType === 'PAR') && node.forOutNodeId) {
      idsToDelete.add(node.forOutNodeId);
} else if (node.type === 'for_out' && node.forNodeId) {
  idsToDelete.add(node.forNodeId);
} else if (node.type === 'par_out') {
  // par_out 节点不可单独删除，忽略
  return;
}
    setNodes(p => p.filter(n => !idsToDelete.has(n.id)));
    setEdges(p => p.filter(e => !idsToDelete.has(e.src) && !idsToDelete.has(e.tgt)));
    setSel(null);
  }, [nodesRef]);

  function handleSelectLib(type, id) {
    setLibSel({ type, id });
    setSel(null);
  }

  const handleBubbleClick = useCallback((nodeId) => {
    setBubbleOverlay({ nodeId });
  }, []);

  const handleBubbleClose = useCallback(() => {
    setBubbleOverlay(null);
  }, []);


  // ── 新建 SOUL ID ──
  const handleCreateSoul = useCallback(async () => {
    setSoulFormError('');
    const { soul_id, soul_name, description } = soulForm;

    // 前端基础校验
    if (!soul_id.trim()) { setSoulFormError('soul_id 不能为空'); return; }
    if (!/^[a-zA-Z0-9]+$/.test(soul_id.trim())) { setSoulFormError('soul_id 只允许英文字母和数字'); return; }

    setSoulFormSubmitting(true);
    try {
      const resp = await fetch(getBackendBaseUrl() + '/api/souls/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          soul_id: soul_id.trim(),
          soul_name: soul_name.trim(),
          description: description.trim(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setSoulFormError(data.error || '创建失败');
        return;
      }
      // 成功：关闭浮层，重置表单
      setSoulModalOpen(false);
      setSoulForm({ soul_id: '', soul_name: '', description: '' });
      setSoulFormError('');
      alert(`SOUL ID "${data.soul_id}" 创建成功！`);
    } catch (e) {
      setSoulFormError('网络错误，请检查后端是否启动');
    } finally {
      setSoulFormSubmitting(false);
    }
  }, [soulForm]);

  // ── 工作流运行：启动运行 ──
  // 【run_request/run-result 链退役（§11.4）】isAi 特判与 onRunResult 回传整体
  // 拆除——AI 的 femo-run 直调 host job_start（B1 死于结构），本函数只服务
  // 人类按钮路径。
  const handleRunWorkflow = useCallback(async (femOverride, source = 'human', opts = {}) => {
    console.log('[handleRunWorkflow] ====== 准备启动 ======');
    console.log('[handleRunWorkflow] flowStatus:', flowStatus);
    // 【2026-09-10 拍板改】运行守卫不信本地 flowStatus——页面不可能知道剧本
    // 在没在跑（SSE 丢失会让本地 running 成为残影：停止黄条+重跑无响应事故）。
    // 本地 running 只当作"该去问"的触发条件：拿会话/Job 问宿主（代理引擎
    // get_job_state，含懒对账），引擎档案说了算。说在跑才拦；说没在跑则本地
    // 状态是残影，放行并校正按钮。询问失败不拦——宿主 GUARD 409 仍兜底。
    if (flowStatus === 'running' && plugin && sessionId) {
      try {
        const qs = new URLSearchParams({ sessionId });
        if (pluginJobId !== null && pluginJobId !== undefined) qs.set('jobId', String(pluginJobId));
        const resp = await fetch(`/dsh-femo/session-state?${qs.toString()}`);
        const st = await resp.json().catch(() => ({}));
        if (st?.state === 'running' || st?.running === true) {
          pushDebug('warn', '运行', '引擎侧该 Job 仍在运行——先停止或等它挂起再跑');
          return;
        }
        setFlowStatus('idle');
      } catch {
        /* 询问失败：放行，宿主 GUARD（assertRunAllowed 409）兜底 */
      }
    } else if (flowStatus === 'running') {
      return;
    }
    // 未落盘修改守卫：文本/图相对 record 有未应用的修改时不直接跑，
    // 弹窗说明分歧点，用户选「回去核查」或「放弃修改直接跑」（record 为准）。
    if (plugin && !skipRunGuardRef.current && (femoDirty || graphDirty)) {
      setRunGuard({ textDirty: femoDirty, graphDirty });
      return;
    }
    skipRunGuardRef.current = false;
    // ⚡ 跑原文（2026-08-22 重构）：人类=以输入框文本为准，不运行前经 buildFEMO 重生成；
    // femOverride 供「放弃修改直接跑」传入 record 原文。
    const femo = typeof femOverride === 'string' && femOverride.trim() ? femOverride : femoText;
    if (!femo || !femo.trim()) {
      alert('请先编写或导入 FEMO 脚本');
      return;
    }
    // ★ 前端语法检查（各自闭环：femogen 不依赖后端也能检查语法）。
    // 统一报错链路：error 阻断运行（红条 + 行号高亮）；warning 不阻断
    // （黄条提醒，照常起跑）。parseFEMO 错误信息含行号/出错语句。
    try {
      const parsed = parseFEMO(femo);
      setFEMOrnings(parsed?.warnings || []);
      if (parsed?.warnings?.length > 0) {
        pushDebug('warn', '语法', `语法检查通过，带 ${parsed.warnings.length} 条警告`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFemoError(msg);
      setFEMOrnings(warningsFromThrowable(e));
      pushDebug('error', '语法', `运行被阻止——${msg}`);
      return;
    }
    pushDebug('info', '运行', '语法检查通过，启动运行');
    console.log('[handleRunWorkflow] 发送到后端...');

    // ★ 运行开始前：初始化模块栈 + 保存当前画布
    moduleStackRef.current = [];
    {
      const cp = locationPathRef.current;
      const cn = nodesRef.current;
      const ce = edgesRef.current;
      setFlowStore(prev => {
        const idx = prev.findIndex(
          f => f.path?.length === cp.length && f.path?.every((s, i) => s === cp[i])
        );
        const entry = { path: [...cp], nodes: cn, edges: ce };
        if (idx >= 0) { const u = [...prev]; u[idx] = entry; return u; }
        return [...prev, entry];
      });
    }

    setFlowStatus('running');
    lastActionAtRef.current = Date.now();
    setNodeStates({});
    setActiveNodeIds(new Set());
    // 新跑/续跑开跑：挂起与重置都会作废旧等待（续跑重发新 wait_key 的
    // human_wait），先清常驻面板账本
    setHumanWaitsBoth({});

    try {
      if (plugin) {
        // 插件模式：交给 dsh-femo 运行（保存剧本 + 启动引擎，同一 run
        // 也驱动聊天窗角色气泡）；SSE 连插件广播路由（相对路径，同源）。
        // 按钮恒定（2026-09-11 定型）：三枚键各钉死一个动作，调用不再随状态漂移——
        // 绿「▶ 运行」= reset:true（fresh_start 从头开演，未开跑/挂起态同一句调用）；
        // 琥珀「继续」= handleResumeWorkflow（resume：reset:false + jobId 指名续跑）。
        // 显式 reset 优先；未显式给的调用方（AI 话术/人类触发/换稿重跑）沿用原判定
        // （paused 外=从头、paused=续跑）。resumeJobId：显式续跑目标 Job 号
        // （2026-09-06 job 快照改造——不依赖宿主 currentJobId 指针）。
        if (typeof onRun === 'function') {
          const runOpts = {
            reset: opts.reset !== undefined
              ? opts.reset === true
              : (opts.forceReset === true ? true : flowStatus !== 'paused'),
          };
          if (opts.resumeJobId !== undefined && opts.resumeJobId !== null) runOpts.jobId = opts.resumeJobId;
          await onRun(femo, runOpts);
        }
        setRunId(null);
        connectSse();
        return;
      }
      // 1. 发送 FEMO 脚本到后端，启动运行（独立模式）
      const resp = await fetch(getBackendBaseUrl() + '/api/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': userApiKey,
          'X-API-Provider': userApiProvider,
          'X-API-Model': apiModelInput, 
          'X-API-Url': userApiUrl,
        },
        body: JSON.stringify({ femo: femo }),
      });
      const data = await resp.json();
      const newRunId = data.run_id;
      setRunId(newRunId);

      // 2. 连接 SSE 流
      const es = new EventSource(
        getBackendBaseUrl() + `/api/run/${newRunId}/stream`
      );
      eventSourceRef.current = es;

es.onmessage = (event) => {
  let evt;
  try {
    evt = JSON.parse(event.data);
  } catch (e) {
    console.error('SSE parse error:', e);
    return;
  }
  if (evt.type === 'heartbeat') return;

  console.log('[SSE onmessage]', event.data);
  handleWorkflowEvent(evt);
};

      es.onerror = (event) => {
        console.error('[SSE] 连接出错或关闭', event);
        console.log('[SSE] readyState:', es.readyState, '(0=CONNECTING, 1=OPEN, 2=CLOSED)');
        es.close();
        eventSourceRef.current = null;
        setFlowStatus('idle');
        // 清空所有活跃节点（SSE 意外断开时安全清空）
        setActiveNodeIds(new Set());
      };
    } catch (err) {
      console.error('Failed to start workflow:', err);
      setFlowStatus('idle');
      setActiveNodeIds(new Set());
      pushDebug('error', '运行', `启动工作流失败：${err?.message ?? err}`);
      alert('启动工作流失败: ' + err.message);
    }
  }, [flowStatus, userApiKey, userApiProvider, userApiUrl, plugin, femoText, femoDirty, graphDirty, onRun, pushDebug, sessionId, pluginJobId]);

  // 【run_request 触发链退役（§11.4）】triggerRunRef/useImperativeHandle 拆除
  // ——AI 触发的唯一生产者 index.runEditorCommand 已死，命令式入口无消费者。

  // 「放弃修改，直接跑」：以 record 为定稿——拉取原文覆盖输入框与画布，
  // 清掉两侧脏标记（applyFEMOText 内部完成），然后带着 record 原文直接运行。
  async function discardChangesAndRun() {
    setRunGuard(null);
    let record = null;
    if (typeof getRecordScript === 'function') {
      try { record = await getRecordScript(); } catch (e) { record = null; }
    }
    if (!record || !record.trim()) {
      alert('无法从会话读取 record 原文，已取消运行');
      return;
    }
    setFemoText(record);
    applyFEMOText(record);
    // 旁路守卫：applyFEMOText 清标志是异步 setState，旧闭包里的脏标志还没刷新，
    // 用 ref 开关让下一次 handleRunWorkflow 直接放行（本次定稿=record，语义一致）。
    skipRunGuardRef.current = true;
    await handleRunWorkflow(record);
  }

  // ── 停止工作流 ──
  // 【2026-09-07 214 事故收尾——静默吞错修复】三级反馈，杜绝"按了没反应"：
  //  ① 请求失败（HTTP 错/超时/异常）→ 红条 error（动作被拒）；
  //  ② stopped:true 但回执 state 已非 running → 引擎侧没有活跃执行体被停
  //     （幂等无操作——214 实锤形态），按引擎回执校准按钮 + 黄条知情；
  //  ③ stopped:true 且 state==='running' → 受理成功，8s 内没等到引擎确认
  //     （flow_stopped/run_state 终态，计时器在此二处清理）→ 黄条警示。
const handleStopWorkflow = useCallback(async () => {
    if (!runId && !plugin) return;
    lastActionAtRef.current = Date.now();
    clearStopConfirmTimer();
    try {
      let data;
      if (plugin) {
        // 显式带当前 Job 号（宿主按引擎档案 host_ref 裁决归属——镜像滞后
        // 也能停）。onStop 失败会 throw（不再吞成 undefined）。
        if (typeof onStop === 'function') {
          data = await onStop(pluginJobId ?? undefined);
        } else {
          const qs = new URLSearchParams({ sessionId });
          if (pluginJobId !== null && pluginJobId !== undefined) qs.set('jobId', String(pluginJobId));
          const resp = await fetch(`/dsh-femo/stop?${qs.toString()}`, { method: 'POST' });
          data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data?.error ?? `stop HTTP ${resp.status}`);
        }
      } else {
        const resp = await fetch(getBackendBaseUrl() + `/api/run/${runId}/stop`, { method: 'POST' });
        data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error ?? `stop HTTP ${resp.status}`);
      }
      if (data && data.stopped === false) {
        // 宿主说该会话无活跃剧本（页面状态残留）：按钮回空闲。
        setFlowStatus('idle');
        return;
      }
      const st = data && data.state;
      if (st && st !== 'running') {
        if (data.confirmed) {
          // 【2026-09-10 停止确认竞态修复】confirmed=本次停止真实停掉了运行中
          // 的 Job（引擎 join 后终态随回执到达）——当场确认收货：按钮回继续态、
          // 不依赖 SSE flow_stopped（它先于回执广播，若按旧逻辑此刻才起 8s
          // 计时器，确认已过、计时器永远等不到 → 黄条误报实锤）。
          setFlowStatus(st === 'suspended' ? 'paused' : 'idle');
          showStopNotice('info', '已停止并挂起（断点保留，可继续）');
          return;
        }
        // 幂等无操作（引擎档案已非 running——被对账改写/已收尾，没有活跃
        // 执行体被停）：按钮按引擎回执校准，黄条知情（不冒充停止成功）。
        setFlowStatus(st === 'suspended' ? 'paused' : 'idle');
        showStopNotice('warning',
          `停止已受理，但引擎侧该 Job 状态为 ${st}——没有活跃执行体被停止（可能此前已被挂起/对账）`);
        return;
      }
      // 受理成功：等引擎确认（flow_stopped → run_state suspended → 计时器清理）。
      if (stopConfirmTimerRef.current) clearTimeout(stopConfirmTimerRef.current);
      stopConfirmTimerRef.current = setTimeout(() => {
        stopConfirmTimerRef.current = null;
        showStopNotice('warning',
          '停止请求已发出 8 秒仍未收到引擎确认——引擎可能已僵死（取消令牌未送达），请重启宿主/引擎后对账恢复');
      }, 8000);
      // 状态将由 flow_stopped 事件更新
    } catch (err) {
      console.error('停止失败:', err);
      // 请求失败=动作被拒：红条可见报错（宿主侧同款已进错误面板），按钮不回退。
      showStopNotice('error', `停止失败：${err?.message ?? err}`);
    }
  }, [runId, plugin, onStop, sessionId, pluginJobId, showStopNotice, clearStopConfirmTimer]);

  // ── 继续工作流 ──
  const handleResumeWorkflow = useCallback(async () => {
    lastActionAtRef.current = Date.now();
    if (plugin) {
      // 插件模式：续跑 = 重新发起 run，带显式 reset:false → host 走 job_resume
      // 六关续跑（断点归引擎 runs 档案）。reset 显式给死（2026-09-11 按钮恒定
      // 定型）：这枚「继续」键的调用与 flowStatus 无关。显式带当前 Job 号——
      // 宿主 currentJobId 可能仍指向别的场次（续跑旧 Job 场景）。
      await handleRunWorkflow(undefined, 'human', { resumeJobId: pluginJobId ?? undefined, reset: false });
      return;
    }
    if (!runId) return;
    try {
      await fetch(getBackendBaseUrl() + `/api/run/${runId}/resume`, { method: 'POST' });
      setFlowStatus('running');
    } catch (err) {
      console.error('继续失败:', err);
    }
  }, [runId, plugin, handleRunWorkflow, pluginJobId]);

  // ── 零 token 调试干跑（2026-09-08）：「🐞 调试」按钮 ──
  // femo_debugger FakeHost 替 AI/human 发言，引擎真实链路干跑剧本；
  // /dsh-femo/debug-run 以 NDJSON 流式回传 DebugLogBus 记录，这里逐行
  // 渲染进调试窗（Print 效果）。与正式运行状态机完全独立——任何 flowStatus
  // 下都可用，不碰 job/SSE 链路；仅插件模式提供（独立后端无此路由）。
  const debugRunAbortRef = useRef(null);
  const [debugRunning, setDebugRunning] = useState(false);
  const handleDebugRun = useCallback(async () => {
    if (debugRunAbortRef.current) {
      pushDebug('warn', '调试', '上一轮调试干跑仍在进行中');
      return;
    }
    if (!plugin) {
      alert('调试干跑目前仅在 dsh 插件模式可用');
      return;
    }
    const femo = femoText;
    if (!femo || !femo.trim()) {
      alert('请先编写或导入 FEMO 脚本');
      return;
    }
    // 调试范围跟画布走（2026-09-12）：在哪个画布按「调试」就调试哪个范围——
    // 主画布=整剧本；模块子画布（含嵌套层级）=只跑该模块。locationPath 形如
    // ['mainflow','外层','内层']，去掉首段拼点路径即调试器的模块参数。
    // 读 ref（locationPathRef）不进依赖：按下瞬间的画布位置即权威，且不重建回调。
    const lp = locationPathRef.current || ['mainflow'];
    const debugModule = lp.length > 1 ? lp.slice(1).join('.') : undefined;
    setDebugRunning(true);
    setDebugOpen(true);   // 按了就开调试窗，日志实时流入
    pushDebug('info', '调试', debugModule
      ? `零 token 干跑启动——只跑模块 ${debugModule}（当前在它的子画布；AI/人类节点由调试器替答）…`
      : '零 token 干跑启动——整剧本（当前在主画布；AI/人类节点由调试器替答）…');
    const controller = new AbortController();
    debugRunAbortRef.current = controller;
    try {
      const resp = await fetch('/dsh-femo/debug-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // scriptPath=savedPath：code: file:"xxx.py" 相对引用按原剧本目录解析
        // （与正式运行同语义；未保存过的剧本回退沙盒目录）。
        // module：主画布=整剧本；模块子画布=只跑该模块（嵌套点路径）。
        body: JSON.stringify({
          femo: femo,
          scriptPath: savedPath || undefined,
          module: debugModule,
        }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const detail = await resp.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawRunOutcome = false;   // 是否见过任何轮次结局——区分「真崩溃」与
                                   // 「max_steps 等非 completed 结局」（CLI 退出码
                                   // 只表达后者，不能当异常报）
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          if (rec.kind === 'run_end') sawRunOutcome = true;
          if (rec.kind === 'debug_done') {
            if (rec.exitCode !== 0 && !sawRunOutcome) {
              pushDebug('error', '调试', `调试进程异常退出（code=${rec.exitCode}），详见宿主控制台 [femo-debug:stderr]`);
            }
            continue;
          }
          const entry = debugRecToLine(rec);
          if (entry) pushDebug(entry.level, entry.kind, entry.text);
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        pushDebug('error', '调试', `调试干跑失败：${err?.message ?? err}`);
      }
    } finally {
      debugRunAbortRef.current = null;
      setDebugRunning(false);
    }
  }, [plugin, femoText, pushDebug]);

  // 【2026-08-30 状态实时化】只关 run-scoped 的独立模式流（/api/run/<id>/stream，
  // 运行结束=流终，不关会被 EventSource 当 404 反复重连）；插件模式
  // /dsh-femo/events 是页面级常驻广播——连接必须保留才能收到后续场次事件
  // （flow_start/flow_stopped 等），关了就退回「外部开演看不见」的老坑。
  const closeRunScopedSse = useCallback(() => {
    const es = eventSourceRef.current;
    if (es && !String(es.url ?? '').includes('/dsh-femo/events')) {
      es.close();
      eventSourceRef.current = null;
    }
  }, []);

  // ═══ 浮层弹出裁决（2026-09-11 v9 · 刷新恢复浮层风暴修复）═══
  // 用户点名：①挂起态刷页面=什么都不弹（此前历史 human_wait 重放帧被当活事件，
  // 把整场弹过的输入浮层"走马灯"一遍）；②运行态刷页面=只弹"当前在跑的节点"，
  // 有人类输入则优先人类输入。三个门（缺一不可）：
  //  - 门一（帧源）：只有"活帧"能弹——replay/_replayed 追平帧一律只恢复状态；
  //  - 门二（场态）：只有本场真在跑才弹（挂起/空闲=零浮层，不再依赖宿主是否
  //    清了 waitingHuman）；
  //  - 门三（目标）：接通时的浮层由 /session-state 权威快照指定——人类等待
  //    快照优先，否则引擎 checkpoint（=进入节点前记录的位置，运行中即当前节点）。
  const waitingRestoreRef = useRef(null);    // 已恢复过的 waitKey（防重复弹人类气泡）
  const currentNodePopRef = useRef(null);    // 已自弹过的当前节点 label（防重复弹节点浮层）
  const canPopOverlay = useCallback(
    () => !plugin || flowStatusRef.current === 'running',
    [plugin],
  );

  /** 按 label 定位节点（可跨画布：命中子画布节点即切到该画布，与 module_enter
   *  同款导航）。画布与 flowStore 都还没灌到 → 返回 null，由调用方等下一次提交重试。
   *  label 双形态匹配（`[开场]` / `开场`）——与断点高亮 effect 同口径，兼容存量
   *  记录里不带方括号的 label。 */
  const findNodeByLabel = useCallback((label) => {
    if (!label) return null;
    const hit = (n) => n.label === label || '[' + label + ']' === n.label;
    let node = nodesRef.current.find(hit);
    if (!node) {
      const ownerFlow = flowStoreRef.current.find((f) => f.nodes?.some(hit));
      if (ownerFlow) {
        node = ownerFlow.nodes.find(hit);
        if (
          Array.isArray(ownerFlow.path) &&
          ownerFlow.path.join('/') !== locationPathRef.current.join('/')
        ) {
          console.log('[FEMO] 接通恢复：节点在其它画布，自动切换:', label, '→', ownerFlow.path.join('/'));
          saveAndNavigateRef.current(ownerFlow.path);
        }
      }
    }
    return node || null;
  }, []);

  /** 人类等待快照 → 画布恢复（nodeStates + 独立账本 + 高亮 + 弹输入气泡）。
   *  【2026-09-06 刷新恢复】宿主 session-state 的 waitingHuman 是权威源（SSE
   *  重放环可能已不含 human_wait）；waitKey 记账防重复弹（用户关掉后不再自弹，
   *  引擎重新等待会有新 waitKey 走活事件路径）。画布未灌好时不记账、静默返回，
   *  由调用方等 nodes/flowStore 下一次提交重试。 */
  const restoreHumanWait = useCallback((wh) => {
    if (!wh || !wh.nodeName || !wh.waitKey) return;
    if (waitingRestoreRef.current === wh.waitKey) return;   // 已恢复过：不重复弹
    const node = findNodeByLabel(wh.nodeName);
    if (!node) return; // 画布/flowStore 尚未灌好：等下一次依赖变化重试
    waitingRestoreRef.current = wh.waitKey;
    const nid = node.id;
    setNodeStates((prev) => ({
      ...prev,
      [nid]: {
        ...prev[nid],
        status: 'human_wait',
        type: 'human',
        wait_key: wh.waitKey || '',
        context: wh.context || '',
        memory: wh.memory || '',
        showprompt: wh.showprompt || null,
        prompt: wh.prompt || '',
        outVars: Array.isArray(wh.outVars) ? wh.outVars : [],
        inputError: null,
      },
    }));
    // 快照恢复同样写独立账本：否则随后任何 AI 实例事件都会把恢复出来的
    // human_wait 状态冲掉（与 SSE 正常路径同款常驻保障）
    setHumanWaitsBoth((prev) => ({
      ...prev,
      [nid]: {
        wait_key: wh.waitKey || '',
        context: wh.context || '',
        memory: wh.memory || '',
        showprompt: wh.showprompt || null,
        prompt: wh.prompt || '',
        outVars: Array.isArray(wh.outVars) ? wh.outVars : [],
        inputError: null,
      },
    }));
    setActiveNodeIds((prev) => new Set([...prev, nid]));
    setBubbleOverlay({ nodeId: nid });
    console.log('[FEMOEditor] waitingHuman 快照恢复:', wh.nodeName, wh.waitKey);
  }, [findNodeByLabel, setHumanWaitsBoth]);

  /** 接通时弹"当前在跑的节点"浮层（运行态刷页面/手机切回重连的唯一自动浮层）。
   *  label 记账：同一节点同一页只自弹一次——用户关掉后不再自弹；跑到下一个
   *  节点=新 label，下次接通才再弹。非 action 节点（网关/模块/特殊节点）不弹
   *  （浮层只渲染 action 节点，弹了也是空白框）。画布未就绪则不记账，由调用方
   *  等 nodes/flowStore 下一次提交重试。 */
  const popCurrentNode = useCallback((label) => {
    if (!label || currentNodePopRef.current === label) return;
    const node = findNodeByLabel(label);
    if (!node) return;                            // 画布未就绪：等下一次提交重试
    currentNodePopRef.current = label;            // 找到即记账（非 action 也不再重试）
    if (node.type !== 'action') return;
    setBubbleOverlay({ nodeId: node.id });
    console.log('[FEMOEditor] 接通恢复：弹出当前运行节点浮层:', label);
    pushDebug('info', '恢复', `接通：弹出当前运行节点「${label}」`);
  }, [findNodeByLabel, pushDebug]);

  /** 浮层跟随运行（B 规则，2026-09-11 用户点名）：
   *  **浮层已开着**时，运行进入下一个节点就切到那个节点；浮层关着则完全不动。
   *  唯一例外=人类等待：human_wait 一律自动弹开（即使原本关着，见 handleWorkflowEvent
   *  的弹泡点）——人类输入要花时间，不能等用户自己去点。
   *  人类等待挂起期间不让位：par 并发下 AI 分支照常推进，人类输入框优先（用户口径）。
   *  追平帧（replay/_replayed）与挂起/空闲态照旧不动作（沿用同一套门卫）。 */
  const followRunningNode = useCallback((label, nodeId) => {
    if (nodeId === undefined || nodeId === null) return;
    if (!canPopOverlay()) return;                                  // 门二：挂起/空闲不弹
    if (bubbleOverlayRef.current === null) return;                 // B：关着就不打扰
    if (Object.keys(humanWaitsRef.current).length > 0) return;     // par：人类输入优先，不让位
    if (bubbleOverlayRef.current.nodeId === nodeId) return;        // 已在该节点
    currentNodePopRef.current = label ?? currentNodePopRef.current; // 与接通弹点的记账同源
    setBubbleOverlay({ nodeId });
    console.log('[FEMOEditor] 浮层跟随运行:', label);
  }, [canPopOverlay]);

  // ── 处理工作流事件 ──
const handleWorkflowEvent = useCallback((evt) => {
  if (evt.type !== 'heartbeat') {
    console.log('[SSE event]', evt);
    console.log('[handleWorkflowEvent] 收到事件', evt);
  }
  const { type, data } = evt;
    console.log('[SSE event]', evt);

    // 无需节点匹配的事件：直接处理或忽略
    if (type === 'heartbeat' || type === 'step') return;
    // femo_stream=聊天流/投影窗直播帧（stream-store 消费），画布不使用——
    // 全局 SSE 里帧量大且多无 node_name，不过滤会每帧刷告警（2026-08-28 降噪）。
    if (type === 'femo_stream') return;
    // 【A4 前端半场（§11.1）】插件模式按会话过滤：引擎事件信封带 sid
    // （bridge make_event_callback 注入 job_id，宿主补 sid）——非本会话的
    // 事件整条丢弃（跨会话不串台）。独立模式无 sid 恒接受。
    if (plugin && data && data.sid !== undefined && data.sid !== sessionId) return;
    // 当前 Job 号实时跟随（所有带 job_id 的事件统一在此捕获——run_state 快照、
    // flow_start/flow_stopped 信封全都带；见 pluginJobId 声明处注释）。
    if (plugin && data && data.job_id !== undefined) {
      const jid = Number(data.job_id);
      if (Number.isFinite(jid) && jid > 0) setPluginJobId(jid);
    }

    // ═══ 调试窗口喂食（2026-09-07）═══
    // 放在会话过滤之后（别的会话的事件不进本窗口）、节点匹配关卡之前
    // （匹配不到节点的报错过去在这里被整条吞掉，日志流里至少留得住痕）。
    // summarizeDebugEvent 返回 null（内部信号）不喂；数组（compile_warnings）
    // 逐条喂。
    {
      const sum = summarizeDebugEvent(type, data);
      if (Array.isArray(sum)) sum.forEach((s) => pushDebug(s.level, type, s.text));
      else if (sum) pushDebug(sum.level, type, sum.text);
    }
    if (type === 'run_state') {
      // 【flowStatus 快照驱动（§11.2）】状态判定以宿主广播的快照为准
      // （B7 死于结构：不再有本地兜底覆盖）。
      const s = data?.state;
      if (s !== 'running') clearStopConfirmTimer();   // 引擎确认到达（或终态校正）——撤停止确认计时器
      if (s === 'running') setFlowStatus('running');
      else if (s === 'suspended') setFlowStatus('paused');
      else if (s === 'finished' || s === 'failed') setFlowStatus('idle');
      return;
    }
    // 【刷新恢复缓冲（2026-09-06）】画布尚未从会话快照恢复（applyFEMOText
    // 未灌 nodes/flowStore）时，需要节点匹配的事件必然匹配失败被丢弃——
    // 刷新后运行中小气泡尽失的直接原因。入队（标记 _replayed：重放的
    // human_wait/node_retry 只恢复状态不自动弹气泡——已结束场次的残留
    // human_wait 在环里会被重放，无脑弹会鬼影），恢复完成后按序补放。
    if (plugin && !restoreDoneRef.current) {
      const nodeScoped = !['flow_start', 'flow_done', 'flow_stopped', 'done', 'module_enter', 'module_exit', 'flow_error', 'notify_author'].includes(type);
      if (nodeScoped) {
        pendingReplayRef.current.push({ ...evt, _replayed: true });
        return;
      }
    }
    // 【D3 收尾（§十四.2）】flow_error/notify_author 不依赖节点匹配：
    // 错误类事件可能无 node_name（worker 构造期异常）或节点不在当前画布
    // （模块/网关），旧白名单会把它们在匹配关卡整条吞掉（连 alert 都到不了
    // ——错误静默消失）。信封化后（宿主 §6.2.12）这两类直接下行走展示面。
    const needsNodeMatch = !['flow_start', 'flow_done', 'flow_stopped', 'done', 'module_enter', 'module_exit', 'flow_error', 'notify_author'].includes(type);

    let matchedNode = null;
    let nodeId = undefined;

    if (needsNodeMatch) {
      const actionName = data?.node_name;
      if (!actionName) {
        console.warn('[FEMO] 事件缺少 node_name:', type, data);
        return;
      }
      const currentNodes = nodesRef.current;
      matchedNode = currentNodes.find((n) => n.label === actionName);
      if (!matchedNode) {
        // 跨画布兜底（2026-09-06）：job_resume 恢复运行时引擎**不重发
        // module_enter**（模块栈引擎内部静默恢复）——画布还停在主流程，而
        // 事件节点（如 human_wait 的 [wolf_discuss]）在模块子画布里，旧逻辑
        // 在此直接丢弃整条事件：wait_key 不落、气泡不弹，人类输入凭空失效。
        // 按 label 从 flowStore 全局找节点；找到就切到它所在的画布（与
        // module_enter 同款导航）再应用事件，nodeId 在 flowStore 往返中稳定。
        const ownerFlow = flowStoreRef.current.find(
          (f) => f.nodes?.some((n) => n.label === actionName)
        );
        if (ownerFlow) {
          const ownerNode = ownerFlow.nodes.find((n) => n.label === actionName);
          nodeId = ownerNode.id;
          matchedNode = ownerNode;
          if (
            Array.isArray(ownerFlow.path) &&
            ownerFlow.path.join('/') !== locationPathRef.current.join('/')
          ) {
            console.log('[FEMO] 节点在其它画布，自动切换:', actionName, '→', ownerFlow.path.join('/'));
            saveAndNavigateRef.current(ownerFlow.path);
          }
        } else {
          console.error(
            `[FEMO Editor] 无法匹配节点 "${actionName}"\n` +
            `画布上的所有 action 节点如下：\n` +
            currentNodes
              .filter(n => n.type === 'action')
              .map(n => `  name="${actionStore.find(a => a.id === n.actionId)?.name || '?'}", label="${n.label}", id="${n.id}"`)
              .join('\n')
          );
          return;
        }
      }
      nodeId = matchedNode.id;
    }
    console.log('[handleWorkflowEvent] type:', type, 'nodeId:', nodeId, 'matchedNode:', matchedNode?.label);

    switch (type) {
      case 'module_enter': {
        const enterName = data.module_name;
        // [femo-diag] SSE 导航事件会切换画布路径——跨会话串扰时这里是第一现场
        try { console.log('[femo-diag] evt module_enter module=' + enterName + ' dataSid=' + (data?.sessionId ?? 'none')); } catch {}
        console.log('[module_enter] module_name:', enterName, 'moduleStack:', [...moduleStackRef.current]);
        moduleStackRef.current.push(enterName);
        const targetModule = moduleStoreRef.current.find(m => m.name === enterName);
        if (targetModule) {
          console.log('[module_enter] 切换到画布:', targetModule.path);
          saveAndNavigateRef.current(targetModule.path);
        } else {
          console.warn('[module_enter] 模块未找到:', enterName, 'moduleStore:', moduleStoreRef.current.map(m => m.name));
        }
        break;
      }

      case 'module_exit': {
        const exitName = data.module_name;
        console.log('[module_exit] module_name:', exitName, 'moduleStack:', [...moduleStackRef.current]);
        moduleStackRef.current.pop();
        const stackTop = moduleStackRef.current[moduleStackRef.current.length - 1];
        if (stackTop) {
          const parentMod = moduleStoreRef.current.find(m => m.name === stackTop);
          if (parentMod) {
            console.log('[module_exit] 回到栈顶模块:', parentMod.path);
            saveAndNavigateRef.current(parentMod.path);
          } else {
            console.warn('[module_exit] 栈顶模块未找到:', stackTop, '，回主流程');
            saveAndNavigateRef.current(['mainflow']);
          }
        } else {
          console.log('[module_exit] 栈空，回主流程');
          saveAndNavigateRef.current(['mainflow']);
        }
        break;
      }

      case 'node_start':
        // 节点开始运行
        setActiveNodeIds(prev => new Set([...prev, nodeId]));
        setNodeStates((prev) => ({
          ...prev,
          [nodeId]: {
            ...prev[nodeId],
            status:
              data.node_type === 'ai'
                ? 'ai_streaming'
                : data.node_type === 'human'
                ? 'human_wait'
                : 'running',
            type: data.node_type,
            prompt: data.prompt || prev[nodeId]?.prompt || '',
            streamingText: '',
            output: '',
            history: data.history || prev[nodeId]?.history || [],
          },
        }));
        // 【B 规则】浮层开着就跟到本节点；关着不动（人类等待那条例外在 human_wait
        // 弹泡点里，永远自动弹开）。追平帧不跟随——历史推进不许带动浮层。
        if (!isCatchUpFrame(evt)) followRunningNode(matchedNode?.label ?? data?.node_name, nodeId);
        break;

      case 'ai_token':
        // AI 流式输出 token
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              status: 'ai_streaming',
              streamingText: (existing.streamingText || '') + data.token,
            },
          };
        });
        break;

      case 'ai_done':
        // AI 输出完成
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除该节点的错误标记（如果有）
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              status: 'ai_done',
              output: data.output || existing.streamingText,
              streamingText: '',
            },
          };
        });
        break;

case 'human_wait':
  console.log('[human_wait] 收到的 data:', data);
  console.log('[human_wait] out_vars:', data.out_vars);
  setActiveNodeIds(prev => new Set([...prev, nodeId]));
  setNodeStates((prev) => ({
    ...prev,
    [nodeId]: {
      ...prev[nodeId],
      status: 'human_wait',
      type: 'human',
      wait_key: data.wait_key || '',  // ← 这行必须有
      context: data.context || '',
      memory: data.memory || '',
      showprompt: data.showprompt || null,
      prompt: data.prompt || prev[nodeId]?.prompt || '',
      outVars: data.out_vars || [],
      inputError: null, // 新一轮等待：清掉上一轮的拒绝/失败红条
    },
  }));
  // 【浮层门卫（2026-09-11 v9）】活帧才弹、且本场在跑才弹——追平帧（宿主重放/
  // 前端补放）只恢复状态；挂起/空闲态零浮层（用户点名）。
  if (!isCatchUpFrame(evt) && canPopOverlay()) setBubbleOverlay({ nodeId });
  // 独立账本：par 并发时 AI 实例事件会覆盖 nodeStates[nodeId]（同 node_id），
  // 人类等待载荷存在 humanWaits 里不被冲掉（气泡常驻的依据）。
  setHumanWaitsBoth((prev) => ({
    ...prev,
    [nodeId]: {
      wait_key: data.wait_key || '',
      context: data.context || '',
      memory: data.memory || '',
      showprompt: data.showprompt || null,
      prompt: data.prompt || prev[nodeId]?.prompt || '',
      outVars: data.out_vars || [],
      inputError: null,
    },
  }));
  break;

case 'node_retry': {
  // 人类输入被引擎拒绝（target='human'，原 human_input_error 迁移，v4 §8.4）：
  // 重新打开输入框并显示错误信息。target='ai' 的重试显示由既有 ai_retry 承担，
  // 画布对它不依赖此事件（忽略，零回归）。
  if (data.target !== 'human') break;
  console.log('[node_retry] 收到的 data:', data);
  const retryError = Array.isArray(data.error) ? (data.error[0] || '') : (data.error || '');
  setActiveNodeIds(prev => new Set([...prev, nodeId]));
  setNodeStates((prev) => ({
    ...prev,
    [nodeId]: {
      ...prev[nodeId],
      status: 'human_wait',
      type: 'human',
      wait_key: data.wait_key || prev[nodeId]?.wait_key || '',
      inputError: retryError || data.feedback || '输入无效，请重新输入',
      outVars: prev[nodeId]?.outVars || [],
    },
  }));
  // 浮层门卫与 human_wait 同款：追平帧（历史 node_retry）不弹、挂起/空闲不弹。
  if (!isCatchUpFrame(evt) && canPopOverlay()) setBubbleOverlay({ nodeId });
  // node_retry（human）= 同一等待的重新打开：同步独立账本的 wait_key/错误条
  setHumanWaitsBoth((prev) => ({
    ...prev,
    [nodeId]: {
      ...(prev[nodeId] || {}),
      wait_key: data.wait_key || prev[nodeId]?.wait_key || '',
      inputError: retryError || data.feedback || '输入无效，请重新输入',
    },
  }));
  break;
}

      case 'context_ready':
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              context: data.context || '',
              showprompt: data.showprompt || null,
              ai_name: data.ai_name || 'AI',
            },
          };
        });
        break;

      case 'human_done':
        // 人类输入完成
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除该节点的错误标记（如果有）
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => {
          const existing = prev[nodeId] || {};
          return {
            ...prev,
            [nodeId]: {
              ...existing,
              status: 'human_done',
              output: data.input || '',
            },
          };
        });
        // 人类实例已交卷：撤下常驻输入面板（par 并发时 AI 分支继续显示）
        setHumanWaitsBoth((prev) => {
          if (!(nodeId in prev)) return prev;
          const next = { ...prev };
          delete next[nodeId];
          return next;
        });
        break;

      case 'func_result':
        // 函数执行结果
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除错误标记
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => {
          // in/out 结构化留存（气泡 In/Out 面板）；output 兜底转字符串防对象直渲染
          const ins = (data.input && typeof data.input === 'object' && !Array.isArray(data.input))
            ? data.input : null;
          const outs = (data.output && typeof data.output === 'object' && !Array.isArray(data.output))
            ? data.output : null;
          return {
            ...prev,
            [nodeId]: {
              ...prev[nodeId],
              status: 'done',
              type: 'func',
              output: typeof data.output === 'string'
                ? data.output
                : (data.output == null ? '' : JSON.stringify(data.output, null, 2)),
              ins,
              outs,
            },
          };
        });
        break;

      case 'assign_result':
        // 赋值结果
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除错误标记
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => {
          // in（每条赋值实际喂入的值）/out（赋值后变量值）结构化留存——气泡 In/Out 面板
          const ins = (data.input && typeof data.input === 'object' && !Array.isArray(data.input))
            ? data.input : null;
          const outs = (data.output && typeof data.output === 'object' && !Array.isArray(data.output))
            ? data.output : null;
          return {
            ...prev,
            [nodeId]: {
              ...prev[nodeId],
              status: 'done',
              type: 'assign',
              output:
                typeof data.output === 'string'
                  ? data.output
                  : JSON.stringify(data.output, null, 2),
              ins,
              outs,
            },
          };
        });
        break;

      case 'notice_done':
        // 公告节点收尾（瞬时节点发完成事件，与 func/assign 同模式）——
        // 不发则画布呼吸灯卡「运行中」直到 flow_done
        setActiveNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        // 清除错误标记
        setErrorNodeIds(prev => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        setNodeStates((prev) => ({
          ...prev,
          [nodeId]: {
            ...prev[nodeId],
            status: 'done',
            type: 'notice',
            output: data.text || '',
          },
        }));
        break;


      case 'flow_start': {
        // 【2026-08-30 状态实时化】任何来源的开演（本页/电脑端/AI/断点续跑）
        // 都把按钮切进运行态——SSE 常驻后本页靠它跟上外部开演。
        // 【2026-09-11 v9】但**追平帧不驱动运行态**：历史 flow_start（挂起前
        // 那一场留下的重放帧）不代表"现在在跑"，旧写法会把挂起态的刷新页点成
        // 运行态（浮层门卫失守、按钮也跟着错）。运行态由权威源裁决：
        // /session-state 的 running、run_state 广播、本页的运行时回调。
        if (!isCatchUpFrame(evt)) setFlowStatus('running');
        setNodeStates({});
        setActiveNodeIds(new Set());
        // 新场次开演：上一场残留的人类等待一并清账（等待随引擎重启作废）
        setHumanWaitsBoth({});
        break;
      }

      case 'flow_stopped':
        // 停止=挂起（可续跑）：断点保留在引擎 runs 档案——按钮回「继续」态。
        // paused/pausedByUser 判定已退役（pause 语义 §11.2）。
        clearStopConfirmTimer();   // 引擎确认到达——撤停止确认计时器（2026-09-07）
        setFlowStatus('paused');
        setActiveNodeIds(new Set());
        closeRunScopedSse();
        // ★ 运行中断：清空模块栈，回主流程
        moduleStackRef.current = [];
        saveAndNavigateRef.current(['mainflow']);
        // 挂起时引擎清 waiting_human（等待作废，续跑会带新 wait_key 重发
        // human_wait）——撤下面板防用户往死等待里打字
        setHumanWaitsBoth({});
        break;

      case 'flow_done':
        // 工作流执行完成（host 已清 checkpoint → 回「运行」态）
        setFlowStatus('idle');
        // 找到 END 节点，呼吸灯停在 END
        const endNode = nodesRef.current.find(
          n => n.type === 'special' && n.specialType === 'END'
        );
        setActiveNodeIds(new Set(endNode ? [endNode.id] : []));
        closeRunScopedSse();
        // ★ 运行结束：清空模块栈，回主流程
        moduleStackRef.current = [];
        saveAndNavigateRef.current(['mainflow']);
        // 终态：不再有活着的引擎等待，撤下常驻人类输入面板
        setHumanWaitsBoth({});
        break;
        break;

      case 'flow_error':
        // 工作流出错（Job failed 终态路径）：nodeId 匹配得到就标红节点
        // （其他分支继续运行）；匹配不到（构造期异常/跨画布）也必须把错误
        // 说出来——D3 之后本 case 不再被匹配关卡拦截。
        if (nodeId) {
          // 标记为错误节点（独立集合，确保变红）
          setErrorNodeIds(prev => new Set([...prev, nodeId]));
          // 同时更新节点状态
          setNodeStates(prev => ({
            ...prev,
            [nodeId]: { ...prev[nodeId], status: 'error' },
          }));
          // 确保该节点仍在活跃集合中（可能有并发分支还在跑）
          setActiveNodeIds(prev => new Set([...prev, nodeId]));
        }
        alert('❌ 剧本运行出错: ' + (data.error || '未知错误'));
        // ★ 出错时清空模块栈（不切画布，让用户看错误）
        moduleStackRef.current = [];
        break;

      case 'notify_author':
        // 「通知作者」信号（错误链路 v4）：宿主已走三通道（femo-run 工具
        // 返回/聊天窗提醒/错误面板），画布只留痕不打扰（不 alert 不标红——
        // 重试类通知后节点可能自愈，标红会留假阳性）。
        console.log('[notify_author]', data?.level ?? '', data?.message ?? data);
        break;

      case 'bridge_run_ended':
        // 整场运行终止信号（引擎 worker 每场必发）：正常结束 ok=true 时
        // flow_done 已复位，这里不重复动（别清掉 flow_done 点亮的 END 呼吸灯）；
        // 异常崩溃 ok=false 时 flow_error 只标红节点不复位 flowStatus——
        // 前端会永远卡 running，后续「运行」全被本组件守卫拒绝
        // （2026-08-29 NameError 卡死事故：编辑器假死只能靠刷新解）。
        if (data?.ok === false) {
          setFlowStatus('idle');
          setActiveNodeIds(new Set());
          moduleStackRef.current = [];
        }
        // 整场终止：引擎等待全部作废，撤下常驻人类输入面板（正常结束路径
        // flow_done 已清，这里兜异常崩溃路径）
        setHumanWaitsBoth({});
        break;

      case 'done':
        // SSE 流结束标记（后端 event_generator 结束时发送）
        setFlowStatus('idle');
        // 清空所有活跃节点（done 事件不携带具体节点信息）
        setActiveNodeIds(new Set());
        // 流终了=本场收尾，等待账本不会还有活口（flow_done/bridge_run_ended
        // 已清）；再兜一次防鬼影输入框
        setHumanWaitsBoth({});
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        // ★ 运行结束：清空模块栈，回主流程
        moduleStackRef.current = [];
        saveAndNavigateRef.current(['mainflow']);
        break;

      default:
        console.warn('[FEMO] 收到未知事件类型:', type, data);
        break;
    }
  }, [closeRunScopedSse, clearStopConfirmTimer, pushDebug]);

  // 连接插件 SSE 广播（运行中打开标签页也实时接入；已连接则先关闭重连）。
  const connectSse = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource('/dsh-femo/events');
    eventSourceRef.current = es;
    es.onopen = () => {
      // 【2026-09-06 多端状态统一】接通/重连即拉权威快照校准 flowStatus：
      // host /events 的重放缓冲只有 100 条，长跑剧本一开跑就把 run_state
      // 快照挤出去——手机/睡眠唤醒等后连设备靠重放学不到状态切换，按钮会
      // 卡在旧态（桌面端点了停止→挂起，手机端不知道，右上角没有「从头」）。
      // 判定与恢复 effect 同源：running→运行；有断点→继续+从头；否则运行。
      // 【2026-09-11 v9】同一份快照兼作"接通浮层裁决"输入：重放帧一律不弹
      // （宿主 replay 标记），接通这一刻该弹什么由它说了算——运行中=人类等待
      // 优先、否则弹当前节点；挂起/空闲=零浮层。每次接通都记一条（seq 递增），
      // label/waitKey 记账保证同一目标不重复弹。
      if (Date.now() - lastActionAtRef.current < 8000) return; // 本地刚操作过：别闪回
      void (async () => {
        try {
          const resp = await fetch(`/dsh-femo/session-state?sessionId=${encodeURIComponent(sessionId)}`);
          const data = await resp.json().catch(() => null);
          if (!data || data.ok !== true) return;
          const hasCkpt = data.checkpoint && Object.keys(data.checkpoint).length > 0;
          setFlowStatus(data.running === true ? 'running' : (hasCkpt ? 'paused' : 'idle'));
          setAttachSnapshot({
            running: data.running === true,
            checkpoint: mainCheckpointLabel(data.checkpoint),
            waitingHuman: data.waitingHuman ?? null,
            seq: ++attachSeqRef.current,
          });
        } catch { /* 网络抖动：等下一次重连再校准 */ }
      })();
    };
    es.onmessage = (event) => {
      let evt;
      try {
        evt = JSON.parse(event.data);
      } catch (e) {
        console.error('SSE parse error:', e);
        return;
      }
      if (evt.type === 'heartbeat' || evt.type === 'connected') return;
      // 编译器页（2026-09-11）：diag feed 的引擎 print 行不进画布事件入口——
      // 那不是画布事件，进去只落 summarizeDebugEvent 的 default 分支。只认
      // tag='engine'（其余 diag 标签属宿主排障面，不该混进编译器页）。
      if (evt.type === 'femo_diag') { handleDiagFeed(evt.data); return; }
      handleWorkflowEvent(evt);
    };
    es.onerror = (event) => {
      // 【2026-08-30 状态实时化】出错不再自杀式关闭+重置 idle：EventSource
      // 浏览器自动重连，重连后 host /events 重放最近引擎事件自愈（运行中断连
      // 恢复后 flow_start 重放把按钮拉回运行态）——3081 重启窗口/网络抖动
      // 不再把运行态误判成 idle。
      console.error('[SSE] 连接出错，等待浏览器自动重连', event);
      pushDebug('warn', 'SSE', '连接出错，等待浏览器自动重连');
    };
  }, [handleWorkflowEvent, sessionId, pushDebug, handleDiagFeed]);

  // 卸载时关闭 SSE（切换标签页/关闭会话不残留连接）。
  useEffect(() => () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // 【2026-08-30 状态实时化】插件模式挂载即连 SSE：编辑器页是常驻单例，
  // 别处（电脑端/AI/另一设备）开跑/暂停/结束时本页必须实时跟进——host
  // /events 连接建立即重放最近引擎事件（含 flow_start），恢复真实状态；
  // 此后常驻（结束事件只关独立模式 run 流），页面生命周期内场次事件全直达。
  useEffect(() => {
    if (!plugin) return;
    connectSse();
  }, [plugin, connectSse]);

  // 【刷新恢复·补放（2026-09-06）】画布恢复完成后的首次 nodes/flowStore
  // 提交时，按序补放恢复期间缓冲的 SSE 节点事件——运行中的节点状态
  // （小气泡/上下文/等待输入）在刷新后得以重建。声明位置在 flowStoreRef
  // 同步 effect 之后：同一提交内 ref 先新鲜再补放。
  useEffect(() => {
    if (!plugin || !restoreDoneRef.current) return;
    if (pendingReplayRef.current.length === 0) return;
    const queued = pendingReplayRef.current;
    pendingReplayRef.current = [];
    console.log('[FEMOEditor] 恢复完成，补放缓冲事件:', queued.length);
    for (const evt of queued) handleWorkflowEvent(evt);
  }, [plugin, nodes, flowStore, handleWorkflowEvent]);

  // ═══ 接通快照 → 浮层（2026-09-11 v9）═══
  // 「刷新恢复弹什么」的唯一裁决面，两个来源合一（内容去重，避免无谓重弹）：
  //  - props：页面加载时的会话快照（editor-page 的 session-state 轮）；
  //  - es.onopen：SSE 每次接通/重连现拉的同一份快照（手机切回、断线重连）。
  // running=false（挂起/空闲）时快照只用于校准按钮态，浮层一个都不弹。
  const attachSeqRef = useRef(0);
  const [attachSnapshot, setAttachSnapshot] = useState(null);
  const sameAttach = (a, b) =>
    a !== null && b !== null &&
    a.running === b.running &&
    a.checkpoint === b.checkpoint &&
    (a.waitingHuman?.waitKey ?? '') === (b.waitingHuman?.waitKey ?? '');
  useEffect(() => {
    if (!plugin) return;
    const next = {
      running: initialRunning === true,
      checkpoint: initialCheckpoint ?? null,
      waitingHuman: initialWaitingHuman ?? null,
    };
    setAttachSnapshot((prev) => (sameAttach(prev, next) ? prev : { ...next, seq: ++attachSeqRef.current }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, initialRunning, initialCheckpoint, initialWaitingHuman]);

  // 快照消费（画布恢复完成后执行；nodes/flowStore 变化会重试——画布还没灌好时
  // 两个 restore/pop 内部静默返回、不动记账，等下一次提交再来）：
  //  ① 挂起/空闲 → 什么都不弹（用户点名）；② 有等待人类输入 → 恢复输入气泡
  //  （人类输入优先，复用 2026-09-06 写的快照恢复）；③ 否则 → 弹当前在跑的节点。
  useEffect(() => {
    if (!plugin || attachSnapshot === null) return;
    if (!restoreDoneRef.current) return;
    if (attachSnapshot.running !== true) return;
    const wh = attachSnapshot.waitingHuman;
    // ① 有人类等待 → 恢复输入气泡（人类输入优先＝用户点名"可复用的写过逻辑"）
    if (wh && wh.nodeName && wh.waitKey) {
      restoreHumanWait(wh);
      return;
    }
    // ② 否则 → 弹当前在跑的节点（引擎 checkpoint＝进入节点前记录的位置）
    popCurrentNode(attachSnapshot.checkpoint);
  }, [plugin, attachSnapshot, nodes, flowStore, restoreHumanWait, popCurrentNode]);

  // ── 提交人类输入 ──
  // 返回 true=已提交（且 host 回执已送达引擎）/ false=失败（气泡 inputError
  // 显示原因）。此前三层静默（runId 守卫 / wait_key 缺失 / delivered:false
  // 被当成功）叠出「输入一点反应都没有」——2026-09-06 全部改可见回执。
const submitHumanInput = useCallback(
  async (nodeId, chatText, assignments) => {
    // 红条两处都写：气泡常驻卡读 humanWaits，nodeStates 兜底旧视图
    const setWaitError = (msg) => {
      setHumanWaitsBoth((prev) => (
        prev[nodeId] ? { ...prev, [nodeId]: { ...prev[nodeId], inputError: msg } } : prev
      ));
      setNodeStates((prev) => ({
        ...prev,
        [nodeId]: { ...prev[nodeId], inputError: msg },
      }));
    };
    const fail = (msg) => {
      console.error('[submitHumanInput]', nodeId, msg);
      setWaitError(msg);
      return false;
    };
    const hasChat = chatText && chatText.trim();
    const hasVars = assignments && Object.keys(assignments).length > 0;
    // runId 守卫只约束独立模式：插件模式 runId 恒 null（运行由 host 驱动，
    // handleRunWorkflow 显式 setRunId(null)）——旧写法 `!runId ||` 让插件模式
    // 的气泡输入永远在第一行静默返回。与 handleStopWorkflow 的
    // `!runId && !plugin` 同款口径（2026-09-06 修复）。
    if (!plugin && !runId) return fail('提交失败：运行未启动（独立模式缺 runId）。');
    if (!hasChat && !hasVars) return false;

    // 直接从独立账本取（par 并发下 nodeStates[nodeId] 可能已被 AI 实例事件
    // 覆盖成 ai_streaming，wait_key 不再可靠）；账本没有再回退 nodeStates。
    const waitKey = humanWaitsRef.current[nodeId]?.wait_key || nodeStates[nodeId]?.wait_key;
    console.log('[submitHumanInput] nodeId:', nodeId, 'waitKey:', waitKey, 'chatText:', chatText);

    if (!waitKey) {
      return fail('提交失败：引擎等待状态未同步（缺 wait_key）。请回到对话窗口输入，或重新运行。');
    }

    const payload = {
      sessionId,
      wait_key: waitKey,
      chat_text: chatText || '',
      variables: assignments || {},
    };
    console.log('[submitHumanInput] payload:', JSON.stringify(payload));

    try {
      const resp = await fetch(plugin ? '/dsh-femo/human-input' : getBackendBaseUrl() + `/api/run/${runId}/human-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return fail(`提交失败：HTTP ${resp.status}${data?.error ? ` ${data.error}` : ''}`);
      }
      // host 回执 delivered:false = B6 拦截（无活跃 Job/等待态已失效）——
      // 此前被当成功误标 human_done，引擎实际没收到。
      if (data && data.delivered === false) {
        return fail(`提交未送达引擎（${data.note || 'no active job'}）。可回对话窗口输入，或重试。`);
      }
    } catch (err) {
      return fail(`提交失败：${String(err?.message ?? err)}`);
    }

    setNodeStates((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        status: 'human_done',
        output: chatText || '',
      },
    }));
    // 已送达：撤下常驻输入面板（后续 human_done 事件再兜底清一次）
    setHumanWaitsBoth((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    return true;
  },
  [runId, nodeStates, plugin, sessionId]  // nodeStates/sessionId 加入依赖
);

  // 保存当前画布到 flowStore（通用函数）
  const saveCurrentFlow = useCallback(() => {
    setFlowStore((prev) => {
      const exists = prev.findIndex(
        (f) =>
          f.path?.length === locationPath.length &&
          f.path?.every((s, i) => s === locationPath[i])
      );
      const entry = {
        path: [...locationPath],
        nodes: [...nodes],
        edges: [...edges],
      };
      if (exists >= 0) {
        const updated = [...prev];
        updated[exists] = entry;
        return updated;
      } else {
        return [...prev, entry];
      }
    });
  }, [locationPath, nodes, edges]);

  // 进入模块前保存当前画布
  function editModule(mod) {
    saveCurrentFlow();
    setLocationPath(mod.path);
  }

  // 当切换路径时，也应当保存当前画布（将在后续 effect 中处理）

  // Mouse handlers
  const onMM = useCallback(
    (e) => {
      // 节点拖拽、连线时，无需检查 isMouseDownRef
      if (drag) {
        const z = effectiveZoom(cvRef.current);
        setNodes((p) => {
          const draggedNode = p.find(n => n.id === drag.id);
          if (!draggedNode) return p;
          const newX = drag.ox + (e.clientX - drag.sx) / (scale * z);
          const newY = drag.oy + (e.clientY - drag.sy) / (scale * z);
          // FOR↔for_out 联动已抽到 common.applyForLinkage（与手机端 nodeDrag 共用一份定义）
          return applyForLinkage(p, draggedNode, newX, newY);
        });
        return;
      }
      if (conn) {
        const [cx, cy] = xy(e);
        setConn((p) => ({ ...p, mx: cx, my: cy }));
        return;
      }

      // 画布平移：必须按下鼠标才开始判断
      if (!isMouseDownRef.current) return;

      if (!isPanning) {
        const dx = e.clientX - mouseDownPosRef.current.x;
        const dy = e.clientY - mouseDownPosRef.current.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          setIsPanning(true);
          isDraggingRef.current = true;
        }
        return;
      }
      const pz = effectiveZoom(cvRef.current);
      setPan({
        x: panStart.px + (e.clientX - panStart.x) / pz,
        y: panStart.py + (e.clientY - panStart.y) / pz,
      });
    },
    [drag, conn, xy, isPanning, panStart, scale]
  );

  const handleWheel = useCallback(
    (e) => {
      //e.preventDefault();
      e.stopPropagation();
      // 阻止原生事件冒泡，避免全局 Ctrl+滚轮缩放干扰画布
      e.nativeEvent?.stopImmediatePropagation?.();

      // Ctrl / ⌘ + 滚轮 → 缩放
      if (e.ctrlKey || e.metaKey) {
        const rect = cvRef.current?.getBoundingClientRect();
        if (!rect) return;
        const wz = effectiveZoom(cvRef.current, rect);
        // 缩放支点按布局坐标系计算（pan 是布局 px），鼠标先除掉祖先 zoom
        const mouseX = (e.clientX - rect.left) / wz;
        const mouseY = (e.clientY - rect.top) / wz;
        const worldX = (mouseX - pan.x) / scale;
        const worldY = (mouseY - pan.y) / scale;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.min(3, Math.max(0.2, scale * delta));
        const newPanX = mouseX - worldX * newScale;
        const newPanY = mouseY - worldY * newScale;
        setScale(newScale);
        setPan({ x: newPanX, y: newPanY });
      } else {
        // 普通滚轮 / 触控板双指 → 平移画布
        setPan((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    },
    [scale, pan]
  );


  const onMU = useCallback(() => {
    if (drag) {
      const draggedNode = nodesRef.current.find(n => n.id === drag.id);
      if (draggedNode && (draggedNode.specialType === 'START' || draggedNode.specialType === 'IN')) {
        const dx = draggedNode.x;
        const dy = draggedNode.y;
        //console.log('[DEBUG] 入口归零前坐标:', draggedNode.x, draggedNode.y);
        // 平移当前 flow 的所有节点，并将入口归零
        setNodes(prev => {
          const updated = prev.map(n => ({
            ...n,
            x: n.id === draggedNode.id ? 0 : n.x - dx,
            y: n.id === draggedNode.id ? 0 : n.y - dy,
          }));
          const entry = updated.find(n => n.id === draggedNode.id);
          //console.log('[DEBUG] 入口归零后坐标:', entry?.x, entry?.y);
          return updated;
        });
        // 立即同步到 flowStore（不等 saveCurrentFlow）
        setFlowStore(prev => {
          const idx = prev.findIndex(f => f.path?.length === locationPath.length && f.path?.every((s, i) => s === locationPath[i]));
          const entry = { path: [...locationPath], nodes: nodesRef.current.map(n => ({...n})) }; // 这里会拿到旧的 nodes，没关系，下一步会更新
          const updated = idx >= 0 ? [...prev] : [...prev, { path: [...locationPath], nodes: [], edges: [] }];
          if (idx >= 0) updated[idx] = { ...updated[idx], nodes: nodesRef.current.map(n => ({...n})) };
          else updated.push({ path: [...locationPath], nodes: nodesRef.current.map(n => ({...n})), edges: [] });
          //console.log('[DEBUG] flowStore 更新后当前 flow:', updated.find(f => f.path.join('/') === locationPath.join('/'))?.nodes?.find(n => n.specialType === 'START' || n.specialType === 'IN')?.x);
          return updated;
        });
      }
    }
    if (isMouseDownRef.current && !isDraggingRef.current) {
      setSel(null);
    }
    setDrag(null);
    setConn(null);
    setIsPanning(false);
    isDraggingRef.current = false;
    isMouseDownRef.current = false;
  }, [drag, nodesRef]);

  // Canvas mouse down (for panning)
  const onCanvasDown = useCallback(
    (e) => {
      if (!e.target?.dataset?.canvasBg && e.target !== cvRef.current) return;
      if (drag || isPanning || conn) {
        setDrag(null);
        setIsPanning(false);
        setConn(null);
        isDraggingRef.current = false;
        isMouseDownRef.current = false;
        return;
      }
      if (e.button === 0 || e.button === 1) {
        isMouseDownRef.current = true;
        mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
        setPanStart({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
        e.preventDefault();
      }
    },
    [pan, drag, isPanning, conn]
  );

  // Port handlers for a node
  function handlePortDown(e, nodeId, portDir, portX, portY) {
    // Sink-only nodes cannot start connections
    const node = nm.get(nodeId);
    if (node?.type === 'special' && SINK_ONLY.has(node.specialType) && portDir !== 'for_out') return;
    const [cx, cy] = xy(e);
    // 如果提供了实际端口坐标（FOR 出圆圈），使用它；否则从节点坐标计算
    let srcX = portX, srcY = portY;
    if (srcX === undefined || srcY === undefined) {
      // 默认从节点中心计算
      const size = getNodeSize(node);
      srcX = node.x + size.w / 2;
      srcY = node.y + size.h / 2;
    }
    setConn({ srcId: nodeId, srcDir: portDir, mx: cx, my: cy, srcX, srcY });
  }

  function handlePortUp(e, nodeId, portDir) {
    if (!conn) return;
    // 禁止 for_out 节点连向自己
    const targetNode = nm.get(nodeId);
    if ((targetNode?.type === 'for_out' || targetNode?.type === 'par_out') && conn.srcId === nodeId) {
      setConn(null);
      return;
    }
    if (conn.srcId === nodeId) {
      // 自环边
      if (!edges.some((ed) => ed.src === nodeId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: nodeId, tgt: nodeId, cond: '', isSelfLoop: true },
        ]);
      }
      setConn(null);
    } else {
      if (!edges.some((ed) => ed.src === conn.srcId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: conn.srcId, tgt: nodeId, cond: '' },
        ]);
      }
      setConn(null);
    }
  }

  // Handle mouse up on node body (for connection drop)
  function handleBodyMouseUp(e, nodeId) {
    if (conn && conn.srcId !== nodeId) {
      if (!edges.some((ed) => ed.src === conn.srcId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: conn.srcId, tgt: nodeId, cond: '' },
        ]);
      }
      setConn(null);
    }
  }

  // Drag from library
  function handleLibDragStart(e, type, idOrType) {
    e.dataTransfer.setData(
      'application/femo-item',
      JSON.stringify({ type, id: idOrType })
    );
    e.dataTransfer.effectAllowed = 'copy';
  }

  function handleCanvasDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleCanvasDrop(e) {
    e.preventDefault();
    let data;
    try {
      data = JSON.parse(e.dataTransfer.getData('application/femo-item'));
    } catch {
      return;
    }
    if (!data) return;

    const [cx, cy] = xy(e);
    const dropX = cx - 50;
    const dropY = cy - 20;

    if (data.type === 'action') {
      let action = lib.actions.find((a) => a.id === data.id);
      if (action && isFinite(dropX) && isFinite(dropY))
        addNode(action, dropX, dropY);
    } else if (data.type === 'module') {
      const mod = lib.modules.find((m) => m.id === data.id);
      if (mod) addModuleNode(mod, dropX, dropY);
    } else if (data.type === 'special') {
      addSpecialNode(data.id, dropX, dropY);
    } else if (data.type === 'position') {
      addPositionNode(dropX, dropY);
    }
  }

  // Import .femo file（独立模式专用：浏览器 input + FileReader 读入画布）。
  // 插件模式不走这里——导入按钮直调 onImport()（host 弹系统文件选择器，
  // 引用原始位置，2026-08-30）：浏览器 FileReader 拿不到完整路径。
  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        applyFEMOText(event.target.result);
      } catch (err) {
        setFemoError(err.message);
        setFEMOrnings(warningsFromThrowable(err));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // 导入（2026-09-11 改两级）：一级=导入清单（导入过/导出过的 .femo 历史，
  // 权威在 host 侧 src/femo-files.ts），二级=系统文件对话框。
  // 手机端只有一级：对话框开在电脑屏幕上，手机上够不着，给了也是死路。
  // 独立模式（无 host，无账本）直接退回原来的浏览器 file input 行为。
  function handleToolbarImport() {
    if (plugin && typeof onListFemoFiles === 'function') {
      setFemoFileOpen(true);
      setFemoFileError('');
      loadFemoFileList();
      return;
    }
    handleBrowseImport();
  }

  /** 拉清单数据（不动弹窗开关，也不清错误位——错误位由打开弹窗/成功动作管）。 */
  function loadFemoFileList() {
    setFemoFileLoading(true);
    return Promise.resolve()
      .then(() => onListFemoFiles())
      .then(
        (list) => { setFemoFileList(Array.isArray(list) ? list : []); },
        (err) => {
          console.warn('[导入清单] 读取失败:', err);
          setFemoFileList([]);
          setFemoFileError(String(err?.message ?? err));
        },
      )
      .finally(() => { setFemoFileLoading(false); });
  }

  /** 二级：系统文件选择器（电脑端专属）。这条就是本次改动之前的原逻辑，行为未动；
   *  独立模式仍是浏览器 file input + FileReader。 */
  function handleBrowseImport() {
    // 插件模式：host 弹系统文件选择器（引用原始位置，2026-08-30）→ 画布载入；
    // 独立模式：浏览器 file input + FileReader。
    if (plugin && typeof onImport === 'function') {
      onImport().then((picked) => {
        if (picked === null) return; // 用户取消
        setFemoFileOpen(false);
        applyFEMOText(picked.content);
      }).catch((err) => {
        console.warn('[导入 .femo] 失败:', err);
        alert(String(err?.message ?? err));
      });
      return;
    }
    fileInputRef.current?.click();
  }

  /** 从清单里挑一条：host 读盘取正文 → 载入画布。收尾（会话记录 {path, text}
   *  + 后台 scriptPath）与「浏览选中」共用 host 侧同一段，两条入口落点一致。 */
  function handlePickFromList(path) {
    if (typeof onPickFemoFile !== 'function') return;
    setFemoFileBusyPath(path);
    onPickFemoFile(path)
      .then((picked) => {
        setFemoFileOpen(false);
        setFemoFileError('');
        applyFEMOText(picked.content);
      })
      .catch((err) => {
        console.warn('[导入清单] 打开失败:', err);
        setFemoFileError(String(err?.message ?? err));
        // 顺手重拉清单：刚才那条多半是被移走/删了，重拉后它会变灰并标「不在原位置」
        loadFemoFileList();
      })
      .finally(() => { setFemoFileBusyPath(null); });
  }

  async function handleToolbarExport() {
    if (exportBusy) return;
    console.log('[导出 .femo] 开始即时生成');
    const exportText = handleGraphToFemo();
    console.log('[导出 .femo] 生成完成, 长度:', exportText.length);
    if (plugin && typeof onExport === 'function') {
      // 插件模式：系统保存文件对话框选位置命名 → 服务端保存 → 地址存会话。
      setExportBusy(true);
      try {
        const path = await onExport(exportText, proj.name || 'flow');
        if (path !== undefined) {
          console.log('[导出 .femo] 已保存到:', path);
          showExportToast(`✓ 已保存到 ${path}`);
        }
        // path === undefined：用户在「未改动」弹窗选了返回画布，不提示。
      } catch (err) {
        console.warn('[导出 .femo] 保存失败:', err);
        alert(String(err?.message ?? err));
      } finally {
        setExportBusy(false);
      }
      return;
    }
    // 独立模式：浏览器下载（原行为）。
    const blob = new Blob([exportText], {
      type: 'text/plain',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${proj.name || 'flow'}.femo`;
    a.click();
    console.log('[导出 .femo] 下载已触发');
    showExportToast(`✓ 已开始下载 ${proj.name || 'flow'}.femo`);
  }

  // Apply FEMO text (from preview or import)
  function applyFEMOText(text) {
    console.log('1. 开始解析');
    const parsed = parseFEMO(text);
    // 非阻断警告上屏（warning 不影响画布落地，只黄条提醒）
    setFEMOrnings(parsed?.warnings || []);
    console.log('2. 解析完成', parsed);
    console.log('3. 开始转换为图');
    const {
      proj: _proj,
      libActions,
      libModules,
      nodes: newNodes,
      edges: newEdges,
      mainflowNodes,
      mainflowEdges,
    } = parsedToGraph(parsed, mode, currentModuleName);
    let newProj = _proj;  // 允许后续修改
    console.log('4. 图转换完成', {
      libActions,
      libModules,
      nodes: newNodes,
      edges: newEdges,
    });
    console.log('5. 准备 setState');
    // 确保 delay 等 meta 字段从解析结果中传递过来（graphBuilder 可能遗漏）
    if (parsed.meta.delay != null) {
      newProj = { ...newProj, delay: parsed.meta.delay };
    }
    setProj(prev => ({ ...prev, ...newProj }));
    setActionStore(libActions); // libActions 已是扁平数组（含模块内部 action）
    setModuleStore(libModules);
    // 构建 flowStore：主流程 + 所有模块
    // 构建 flowStore
    const newFlowStore = (libModules || []).map((mod) => ({
      path: mod.path,
      nodes: mod.nodes || [],
      edges: mod.edges || [],
    }));
    // 根据当前路径更新或添加对应 flow
    const targetPath = locationPath;
    const existingIdx = newFlowStore.findIndex(
      (f) =>
        f.path.length === targetPath.length &&
        f.path.every((s, i) => s === targetPath[i])
    );
    if (existingIdx >= 0) {
      newFlowStore[existingIdx] = {
        path: targetPath,
        nodes: newNodes,
        edges: newEdges,
      };
    } else {
      newFlowStore.push({ path: targetPath, nodes: newNodes, edges: newEdges });
    }
    // 确保主流程存在（若当前不在主流程），使用解析出的真实 mainflow 图
    if (targetPath.length !== 1 || targetPath[0] !== 'mainflow') {
      const mainflowIdx = newFlowStore.findIndex(
        (f) => f.path.length === 1 && f.path[0] === 'mainflow'
      );
      if (mainflowIdx >= 0) {
        newFlowStore[mainflowIdx] = { path: ['mainflow'], nodes: mainflowNodes, edges: mainflowEdges };
      } else {
        newFlowStore.push({ path: ['mainflow'], nodes: mainflowNodes, edges: mainflowEdges });
      }
    }
    setFlowStore(newFlowStore);
    setNodes(newNodes);
    setEdges(newEdges);
    // [femo-diag] 恢复链路取证：文本生图落画布时的规模快照（连接线丢失调查）
    try { console.log('[femo-diag] applyFEMOText path=' + targetPath.join('/') + ' nodes=' + newNodes.length + ' edges=' + newEdges.length); } catch {}
    console.log('6. setState 完成');
    setFemoDirty(false);
    setGraphDirty(false);
    setFemoError(null);
    setLastValidFemo(text);
    setSel(null);
    // 建立结构基线：此刻画布与原文一致，之后的结构性变化才计为「图被修改」。
    lastSyncedGraphRef.current = structuralSignature(newNodes, newEdges);
    console.log('7. 全部完成');
  }

  // ═══ [图到文本]：当前画布 → .femo 文本 ═══
  // 同步 return text，因为 setState 是异步的，调用方（运行/导出）直接用返回值
  function handleGraphToFemo() {
    //console.log('[handleGraphToFemo] ====== 开始 ======');
    //console.log('[handleGraphToFemo] locationPath:', locationPath.join('/'));
    //console.log('[handleGraphToFemo] mode:', mode, ', nodes:', nodes.length, ', edges:', edges.length);
    //console.log('[handleGraphToFemo] flowStore 条目:', flowStore.length);
    //console.log('[handleGraphToFemo] moduleStore 条目:', moduleStore.length);
    //console.log('[handleGraphToFemo] actionStore 条目:', actionStore.length);
    //console.log('[handleGraphToFemo] proj.name:', proj.name, 'proj.id:', proj.id);

    // 1. 构建 flowMap
    const flowMap = new Map();
    flowStore.forEach((f) => flowMap.set(f.path.join('/'), f));
    flowMap.set(locationPath.join('/'), { path: locationPath, nodes, edges });
    //console.log('[handleGraphToFemo] flowMap 大小:', flowMap.size);

    // 2. 获取主流程节点/边
    const mainFlow = flowMap.get('mainflow');
    const mainNodes = mainFlow ? mainFlow.nodes : makeDefaultNodes('mainflow');
    const mainEdges = mainFlow ? mainFlow.edges : [];
    //console.log('[handleGraphToFemo] mainFlow 存在:', !!mainFlow);
    //console.log('[handleGraphToFemo] mainNodes:', mainNodes.length, ', mainEdges:', mainEdges.length);

    // 3. 合并 moduleStore 与 flowMap 的最新数据
    const mergedModules = moduleStore.map((mod) => {
      const key = mod.path.join('/');
      const flow = flowMap.get(key);
      return flow ? { ...mod, nodes: flow.nodes, edges: flow.edges } : mod;
    });
    //console.log('[handleGraphToFemo] mergedModules:', mergedModules.length);

    // 4. 调用 buildFEMO（这里是核心计算——含双DFS+全量序列化）
    //console.log('[handleGraphToFemo] 调用 buildFEMO...');
    const newFemo = buildFEMO(
      mainNodes,
      mainEdges,
      proj,
      mode,
      currentModuleName,
      mergedModules,
      actionStore
    );
    //console.log('[handleGraphToFemo] buildFEMO 完成, 长度:', newFemo.length);
    //console.log('[handleGraphToFemo] 前300字符:', newFemo.slice(0, 300));

    // 5. 纯生成，无副作用（2026-08-22 重构）：不再在这里改任何 state。
    //    副作用（更新输入框/落盘/清标志）由定稿按钮的包装函数负责，
    //    导出等只读场景直接拿返回值，不会误伤前端状态。

    // 6. 同步返回——调用方直接用，不依赖异步 state
    //console.log('[handleGraphToFemo] ====== 完成 ======');
    return newFemo;
  }

  // 图生文本定稿按钮：生成标准化文本 → 三处统一（输入框/画布/record）→ 清标志。
  function handleGraphToTextCommit() {
    const out = handleGraphToFemo();
    if (!out || !out.trim()) return;
    setFemoText(out);
    setLastValidFemo(out);
    setFemoError(null);
    setFEMOrnings([]);
    setFemoDirty(false);
    setGraphDirty(false);
    lastSyncedGraphRef.current = structuralSignature(nodes, edges);
    // 链路②：把生成文本写入会话 record（带 baseRev，冲突走 409 弹窗）。
    if (typeof onPersistScript === 'function') onPersistScript(out);
  }

  // useRef 持有最新 handleGraphToFemo 引用
  // handleRunWorkflow 被 useCallback 缓存，闭包里的函数引用可能过时
  // 通过 ref.current() 总是调到本次 render 的最新版
  const handleGraphToFemoRef = useRef(handleGraphToFemo);
  handleGraphToFemoRef.current = handleGraphToFemo;
  //console.log('[ref] handleGraphToFemoRef.current 已更新');

  function handleApplyFemo() {
    console.log('[handleApplyFemo] 开始, femoText 长度:', femoText?.length);
    try {
      applyFEMOText(femoText);
      // 定稿链路①：把输入框原文原样写入会话 record（三处统一）。
      // applyFEMOText 内部已清双标志并刷新结构基线。
      if (typeof onPersistScript === 'function') onPersistScript(femoText);
    } catch (err) {
      console.error('[handleApplyFemo] 异常:', err.message);
      setFemoError(err.message);
      setFEMOrnings(warningsFromThrowable(err));
    }
  }

  function handleRestoreFemo() {
    setFemoText(lastValidFemo);
    setFemoDirty(false);
    setFemoError(null);
    setFEMOrnings([]);
  }

const selNode = sel?.type === 'node' ? nm.get(sel.id) : null;
  const selEdge =
    sel?.type === 'edge' ? edges.find((e) => e.id === sel.id) : null;
  const selAction = selNode?.type === 'action'
    ? actionStore.find((a) => a.id === selNode.actionId)
    : null;

  // ── 响应式布局检测 ──
  const isMobile = useMobile(768);
  // 插件模式手机端全屏态（2026-08-24 用户拍板）：默认「header 在上」的常规
  // 态——任何挂载（含视角跳转、手动开窗）都落在 header 下面，按全屏键才进
  // 沉浸、返回键退出。不再继承该窗口上次的全屏状态。
  const [mobileFs, setMobileFs] = useState(false);
  const themeName = FEMO_THEMES.find((t) => t.id === themeSel)?.name || themeSel;

  // actorNames（手机端 ProjPanel 需要）
  const actorNames = (proj.actors || []).map((a) => a.name.replace('@', ''));

  // Compute temporary connection line
  function getTempConnLine() {
    if (!conn) return null;
    const srcNode = nm.get(conn.srcId);
    if (!srcNode) return null;
    const ss = getNodeSize(srcNode);

    // 对于 FOR 出口，使用出圆圈的位置
    let srcPort;
    switch (conn.srcDir) {
      case 'top':
        srcPort = { x: srcNode.x + ss.w / 2, y: srcNode.y };
        break;
      case 'bottom':
        srcPort = { x: srcNode.x + ss.w / 2, y: srcNode.y + ss.h };
        break;
      case 'left':
        srcPort = { x: srcNode.x, y: srcNode.y + ss.h / 2 };
        break;
      case 'right':
        srcPort = { x: srcNode.x + ss.w, y: srcNode.y + ss.h / 2 };
        break;
      case 'center':
        // ForOut 节点是圆形，使用实际传入的 srcX, srcY
        srcPort = { x: conn.srcX || (srcNode.x + ss.w / 2), y: conn.srcY || (srcNode.y + ss.h / 2) };
        break;
      default:
        srcPort = { x: srcNode.x + ss.w, y: srcNode.y + ss.h / 2 };
    }
    // 【2026-08-30 跟手修复】出口/进入方向不再写死：旧逻辑固定按按下端口的
    // 方向出线 + 机械反向进线，拖动方向与端口方向稍有偏差（如按底部端口往
    // 右上拽），曲线就先反向扎出去再拐回来，画出诡异 S 弯"不跟手"。
    // 现在：按下的端口只决定出线锚点，出口与进入方向都按"鼠标相对端口的
    // 主轴"动态选择——曲线整体流向始终与手势一致。
    const dx = (conn.mx || 0) - srcPort.x;
    const dy = (conn.my || 0) - srcPort.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    // 出口方向：朝鼠标一侧流出
    const srcDir = horizontal ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
    // 进入方向：抵达鼠标点时的行进方向 = 从源端口一侧进入（与出口同轴反向）
    const endDir = horizontal ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom');
    return smartBezier(
      srcPort.x,
      srcPort.y,
      srcDir,
      conn.mx || srcPort.x,
      conn.my || srcPort.y,
      endDir
    );
  }

// ────────────────────────────────────────────────────────────
  // 手机端：构建 canvasContent（SVG + 节点层）传给 MobileLayout
  // 桌面端：内联渲染，结构不变
  // ────────────────────────────────────────────────────────────

  // 删除节点（供手机端 PropsPanel 调用）
  const handleDeleteSelNode = () => {
    if (!sel || sel.type !== 'node') return;
    const node = nm.get(sel.id);
    if (node?.type === 'special') {
      const isMandatory = node.specialType === 'START' || node.specialType === 'IN';
      const sameTypeNodes = nodes.filter(n => n.type === 'special' && n.specialType === node.specialType);
      const isOnlyExit = (node.specialType === 'END' || node.specialType === 'OUT') && sameTypeNodes.length <= 1;
      if (isMandatory || isOnlyExit) return;
    }
    deleteNode(sel.id);
  };
  // 删除边（供手机端 PropsPanel 调用）
  const handleDeleteSelEdge = () => {
    if (!sel || sel.type !== 'edge') return;
    setEdges((p) => p.filter((e) => e.id !== sel.id));
    setSel(null);
  };
  // 修改边条件（供手机端 PropsPanel 调用）
  const handleCondChange = (cond) => {
    if (!sel || sel.type !== 'edge') return;
    setEdges((p) => p.map((ed) => ed.id === sel.id ? { ...ed, cond } : ed));
  };
  // 编辑选中节点的 Action（供手机端 PropsPanel 调用）
  const handleEditSelAction = () => {
    if (!selNode || !selAction) return;
    setModal({ type: 'editNode', action: selAction, nodeId: selNode.id });
  };

  if (isMobile) {
    // 窄视口（手机/平板竖屏）：提供移动端布局。
    // 插件模式同样支持——手机通过 tailscale 访问 dsh 时自动呈现手机版。
    return (
      <ErrorBoundary>
        <FontStyle scoped={plugin} />
        {/* 独立模式导入用的隐藏 file input（插件模式走 host 系统选择器）。
            桌面工具栏那份在手机端不渲染，故此处补一份——与桌面共用同一个
            fileInputRef / handleImportFile，两条分支互斥挂载不冲突。 */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".femo"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
        {/* 运行守卫弹窗（移动端树）：zIndex 1000 > MobileLayout 的 900，确保可见 */}
        {runGuard !== null && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              maxWidth: 430, width: 'calc(100% - 48px)', padding: '18px 20px', borderRadius: 12,
              background: 'var(--femo-surface, #fff)', border: '1px solid var(--femo-border, #e0e0e0)',
              boxShadow: '0 8px 28px rgba(0,0,0,0.22)', fontSize: 13, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>⚠️ 有未落盘修改</div>
              <div style={{ color: 'var(--femo-text-secondary, #666)', marginBottom: 14 }}>
                {runGuard.textDirty && runGuard.graphDirty
                  ? '文本和画布图都被修改过，且互相不统一。'
                  : runGuard.textDirty
                    ? '文本被修改过，尚未应用到画布和 record。'
                    : '画布图被修改过，尚未应用到文本和 record。'}
                建议回去按对应的统一按钮（文本生图 / 图生文本）应用你要的版本；
                也可以放弃这些修改，以最后保存的 record 为准直接运行。
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setRunGuard(null)}
                  style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--femo-border, #ccc)', background: 'transparent', cursor: 'pointer' }}
                >回去核查</button>
                <button
                  onClick={discardChangesAndRun}
                  style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #d96b2b', background: '#d96b2b', color: '#fff', cursor: 'pointer' }}
                >放弃修改，直接跑</button>
              </div>
            </div>
          </div>
        )}
        {/* Module 子画布导航（2026-09-06 手机端补齐）：onNodeDoubleTap=双击节点，
            与桌面 onDbl 同义（module 进子画布 / action 开编辑弹窗）；
            onNavigatePath=标题栏面包屑定位（2026-09-07 对齐桌面语义：点文件名
            回主画布、点模块名定位到该模块，桌面工具栏同款「保存当前画布 +
            切路径」）；onEnterModuleNode=属性面板「进入子画布」按钮。 */}
        <MobileLayout
          theme={theme}
          zIndex={plugin && mobileFs ? 900 : undefined}
          fixedMode={plugin ? mobileFs : true}
          onBack={plugin ? () => { setMobileFs(false); onBackToShell?.(); } : undefined}
          onExpand={plugin ? () => setMobileFs(true) : undefined}
          themeName={themeName}
          onCycleTheme={cycleTheme}
          proj={proj}
          actorNames={actorNames}
          onProjChange={setProj}
          cvRef={cvRef}
          pan={pan}
          setPan={setPan}
          scale={scale}
          setScale={setScale}
nodes={nodes}
          setNodes={setNodes}
          edges={edges}
          sel={sel}
          setSel={setSel}
          drag={drag}
          setDrag={setDrag}
          conn={conn}
          setConn={setConn}
          isPanning={isPanning}
          onMM={onMM}
          onMU={onMU}
          onCanvasDown={onCanvasDown}
          handleWheel={handleWheel}
          handlePortDown={handlePortDown}
          handlePortUp={handlePortUp}
          handleCanvasDragOver={handleCanvasDragOver}
          handleCanvasDrop={handleCanvasDrop}
          canvasOpacity={canvasOpacity}
          canvasContent={
            <>
              <svg
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 24 }}
              >
                <defs>
                  {[['a','var(--femo-edge-flow)'],['as','var(--femo-edge-sel)'],['a_for','var(--femo-edge)'],['al','var(--femo-danger)'],['aj','var(--femo-warning)']].map(([id,col]) => (
                    <marker key={id} id={id} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                      <polygon points="0 0, 8 3, 0 6" fill={col} />
                    </marker>
                  ))}
                  {/* 流光渐变定义已于 round35 随 v8 多层 dash 方案移除（无引用） */}
                </defs>
                {sortedEdges.map((e) => {
                  const s = nm.get(e.src), t = nm.get(e.tgt);
                  if (!s || !t) return null;
                  const isCycleEdge = allCycleEdges.has(e.id);
                  const isParCycle = parCycleEdges.has(e.id);
                  const isParBroken = parBrokenEdges.has(e.id);
                  const isForBroken = forBrokenEdges.has(e.id) && !isCycleEdge; // && !isCycleEdge 对齐桌面端双保险（forBrokenEdges 计算时已排除环边）
                  const isSel = sel?.type === 'edge' && sel.id === e.id;
                  if (e.src === e.tgt) {
                    const ss = getNodeSize(s);
                    const cx = s.x + ss.w / 2, cy = s.y + ss.h / 2;
                    const pathD = `M${s.x+ss.w},${cy} C${cx+ss.w*0.8},${s.y-ss.h*0.4} ${cx+ss.w*0.8},${s.y-ss.h*0.4} ${cx},${s.y}`;
                    return (
                      <g key={e.id}>
                        <path d={pathD} fill="none" stroke="transparent" data-edge-id={e.id} strokeWidth={18} style={{cursor:'pointer',pointerEvents:'stroke'}} onClick={(ev) => { ev.stopPropagation(); setSel({ type: 'edge', id: e.id }); }} />
                        <path d={pathD} fill="none" stroke={isSel?'var(--femo-edge-sel)':'var(--femo-edge)'} strokeDasharray="5,3" markerEnd={`url(#${isSel?'as':'a_for'})`} style={{pointerEvents:'none', strokeWidth: isSel?'var(--femo-edge-w-sel)':'var(--femo-edge-w-thin)'}} />
                        {/* 流光：三层渐变光斑沿箭头方向流动（仅深色主题由 CSS 点亮） */}
                        <EdgeShimmer d={pathD} w={0.85} />
                      </g>
                    );
                  }
                  // 对齐桌面端的对象传参（2026-08-24 修复：旧版位置传参使 isCycleEdge/isParEdge/
                  // portEdgeGroupMap 全部退化为默认值——PAR 五线并一条、同端口多边不分流）
                  const geo = computeEdgeGeometry(e, s, t, {
                    isCycleEdge,
                    isParEdge: isParCycle || isParBroken,
                    parLineCount: 5,
                    parGap: 6,
                    portEdgeGroupMap,
                  });
                  if (!geo) return null;
                  const { pathDs, labelPos, srcDir, tgtDir } = geo;
                  const stroke = isSel ? 'var(--femo-edge-sel)' : isParBroken || isForBroken ? 'var(--femo-danger)' : isCycleEdge || isParCycle ? 'var(--femo-edge)' : 'var(--femo-edge-flow)';
                  // 虚线规则对齐桌面端（仅断裂边虚线）：环边实线——旧版 isCycleEdge?'7,3'
                  // 是手机端独有样式，把 FOR 循环回边错误画成虚线（2026-08-24 猫猫报告）
                  const dashed = isParBroken || isForBroken ? '5,3' : null;
                  const markerId = isSel ? 'as' : isParBroken || isForBroken ? 'al' : isCycleEdge || isParCycle ? 'a_for' : 'a';
                  return (
                    <g key={e.id}>
                      {pathDs.map((d, i) => (
                        <path key={i} d={d} fill="none" stroke="transparent" data-edge-id={e.id} strokeWidth={18} style={{cursor:'pointer',pointerEvents:'stroke'}} onClick={(ev) => { ev.stopPropagation(); setSel({ type: 'edge', id: e.id }); }} />
                      ))}
                      {pathDs.map((d, i) => (
                        <g key={`v${i}`}>
                          {/* 每条线都带箭头（对齐桌面端；单线边行为不变） */}
                          <path d={d} fill="none" stroke={stroke} strokeDasharray={dashed} markerEnd={`url(#${markerId})`} style={{pointerEvents:'none', strokeWidth: isSel?'var(--femo-edge-w-sel)':'var(--femo-edge-w-thin)'}} />
                          {/* 流光：仅金线（红色语义边不发光） */}
                          {!(isParBroken || isForBroken) && <EdgeShimmer d={d} w={0.85} />}
                        </g>
                      ))}
                      {/* 条件标签：与桌面端同款（2026-09-11 用户点名）——手机端此前是
                          rect 背景框 + 8 字截断（"done ==…"），现改为无框 + 全文显示，
                          字号/基线（9.5 / +4.5）与桌面端一致；手机端 SVG 整体
                          pointerEvents:none，文字不吃事件。 */}
                      {e.cond && labelPos && (
                        <text
                          x={labelPos.x}
                          y={labelPos.y + 4.5}
                          textAnchor="middle"
                          fontSize={9.5}
                          fontWeight={700}
                          fill={stroke}
                          fontFamily="var(--femo-font-mono)"
                          style={{ pointerEvents: 'none' }}
                        >
                          {e.cond}
                        </text>
                      )}
                    </g>
                  );
                })}
                {conn && (() => { const d = getTempConnLine(); return d ? <path d={d} fill="none" stroke="var(--femo-primary)" strokeWidth={2} strokeDasharray="6,3" style={{pointerEvents:'none'}} /> : null; })()}
              </svg>
              {nodes.map((n) => {
                const enrichedNode = n.type === 'action' ? { ...n, action: actionMap.get(n.actionId) } : n;
                const commonProps = {
                  sel: sel?.type === 'node' && sel.id === enrichedNode.id,
                  onBody: (e) => {
                    e.stopPropagation();
                    if (drag || isPanning || conn) { setDrag(null); setIsPanning(false); setConn(null); return; }
                    setSel({ type: 'node', id: enrichedNode.id });
                    setDrag({ id: enrichedNode.id, sx: e.clientX, sy: e.clientY, ox: enrichedNode.x, oy: enrichedNode.y });
                  },
                  onPortDown: (e, dir) => handlePortDown(e, enrichedNode.id, dir),
                  onPortUp: (e, dir) => handlePortUp(e, enrichedNode.id, dir),
                  onBodyMouseUp: (e) => handleBodyMouseUp(e, enrichedNode.id),
                };
                if (enrichedNode.type === 'special') return <SpecialNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} isActive={activeNodeIds.has(enrichedNode.id)} />;
                if (enrichedNode.type === 'for_out') {
                  const motherNode = enrichedNode.forNodeId ? nm.get(enrichedNode.forNodeId) : null;
                  return <ForOutNodeView key={enrichedNode.id} node={enrichedNode} sel={sel?.type==='node'&&sel.id===enrichedNode.id} forSpecialType={motherNode?.specialType||'FOR'} onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)} onBubbleClick={(nid) => { setDrag(null); setConn(null); setIsPanning(false); setSel({ type: 'node', id: nid }); }} onPortDown={(e, dir, x, y) => handlePortDown(e, enrichedNode.id, dir, x, y)} onPortUp={(e, dir) => handlePortUp(e, enrichedNode.id, dir)} />;
                }
                if (enrichedNode.type === 'par_out') return <ParOutNodeView key={enrichedNode.id} node={enrichedNode} sel={sel?.type==='node'&&sel.id===enrichedNode.id} onBody={(e) => { e.stopPropagation(); if (drag||isPanning||conn){setDrag(null);setIsPanning(false);setConn(null);return;} setSel({type:'node',id:enrichedNode.id}); setDrag({id:enrichedNode.id,sx:e.clientX,sy:e.clientY,ox:enrichedNode.x,oy:enrichedNode.y}); }} onPortDown={(e, dir) => handlePortDown(e, enrichedNode.id, dir)} onPortUp={(e, dir) => handlePortUp(e, enrichedNode.id, dir)} onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)} />;
                if (enrichedNode.type === 'position') return <PositionNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} />;
                return <ActionNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} onBubbleClick={handleBubbleClick} nodeState={nodeStates[enrichedNode.id]} isActive={activeNodeIds.has(enrichedNode.id)} errorNodeIds={errorNodeIds} onDbl={() => { if (enrichedNode.type==='action'&&enrichedNode.action) setModal({type:'editNode',action:enrichedNode.action,nodeId:enrichedNode.id}); else if (enrichedNode.type==='module') { const mod=enrichedNode.modDef; if(mod) editModule(mod); } }} />;
              })}
            </>
          }
          lib={lib}
          mode={mode}
          locationPath={locationPath}
          allNames={allNames}
          onNew={() => setModal({ type: 'new' })}
          onAdd={addNode}
          onAddModule={addModuleNode}
          onAddSpecial={addSpecialNode}
          onAddPosition={addPositionNode}
          onEdit={(a) => setModal({ type: 'edit', action: a })}
          onEditModule={editModule}
          onNodeDoubleTap={(nodeId) => {
            const node = nm.get(nodeId);
            if (!node) return;
            if (node.type === 'module') { const mod = node.modDef; if (mod) editModule(mod); }
            else if (node.type === 'action') { const action = actionMap.get(node.actionId); if (action) setModal({ type: 'editNode', action, nodeId }); }
          }}
          onNavigatePath={(path) => { saveCurrentFlow(); setLocationPath(path); }}
          onEnterModuleNode={(nodeId) => { const mod = nm.get(nodeId)?.modDef; if (mod) editModule(mod); }}
          onDragStart={handleLibDragStart}
          onSelectLib={handleSelectLib}
          onNewModule={(name) => {
            const newPath = [...locationPath, name];
            const newModule = { id: mid(), name, path: newPath, meta: {}, code: [], vars: [], nodes: makeDefaultNodes('module'), edges: [] };
            saveCurrentFlow();
            setModuleStore((prev) => [...prev, newModule]);
            setFlowStore((prev) => [...prev, { path: newPath, nodes: newModule.nodes, edges: newModule.edges }]);
            setLocationPath(newPath);
            setNodes(newModule.nodes);
            setEdges(newModule.edges);
            setFemoDirty(false);
          }}
          libSel={libSel}
          flowStatus={flowStatus}
          hasActiveRunningNodes={hasActiveRunningNodes}
          onRun={() => handleRunWorkflow(undefined, 'human', { reset: true })}
          onStop={handleStopWorkflow}
          onResume={handleResumeWorkflow}
          nodeStates={nodeStates}
          actionStore={actionStore}
          activeNodeIds={activeNodeIds}
          errorNodeIds={errorNodeIds}
          bubbleOverlay={bubbleOverlay}
          onBubbleClose={handleBubbleClose}
          submitHumanInput={submitHumanInput}
          humanWaits={humanWaits}
          onBubbleClick={handleBubbleClick}
          femoText={femoText}
          onFemoChange={(v) => { setFemoText(v); setFemoDirty(true); }}
          femoError={femoError}
          FEMOrnings={FEMOrnings}
          femoDirty={femoDirty}
          debugLog={debugLog}
          onClearDebug={() => setDebugLog([])}
          compilerLog={compilerLog}
          onClearCompiler={() => setCompilerLog([])}
          femogenLog={femogenLog}
          onClearFemogen={clearFemogenLog}
          hostLog={hostLog}
          onClearHost={() => setHostLog([])}
          onCompileDebug={handleDebugRun}
          compilingDebug={debugRunning}
          onApplyFemo={handleApplyFemo}
          onRestoreFemo={handleRestoreFemo}
          onGraphToFemo={handleGraphToTextCommit}
          onImport={handleToolbarImport}
          onExport={handleToolbarExport}
          exportBusy={exportBusy}
          exportToast={exportToast}
          onOpenSoul={() => { setSoulForm({ soul_id: '', soul_name: '', description: '' }); setSoulFormError(''); setSoulModalOpen(true); }}
          backEdges={backEdges}
          onDeleteNode={handleDeleteSelNode}
          onDeleteEdge={handleDeleteSelEdge}
          onCondChange={handleCondChange}
          onEditAction={handleEditSelAction}
        />
        {/* ActionModalSoulModal 在手机端也需要 */}
        {modal && (
          <ActionModal
            init={modal.type !== 'new' ? modal.action : null}
            existingNames={[...allNames]}
            isModuleInternal={mode === 'module'}
            onSave={(action) => {
              const actionWithPath = { ...action, path: action.path || [...locationPath] };
              if (modal.type === 'editNode') {
                setNodes((p) => p.map((n) => n.id === modal.nodeId ? { ...n, label: `[${actionWithPath.name}]` } : n));
              } else if (modal.type === 'edit') {
                setNodes((p) => p.map((n) => n.actionId === actionWithPath.id ? { ...n, label: `[${actionWithPath.name}]` } : n));
              } else {
                addNode(actionWithPath);
              }
              setActionStore((prev) => {
                const idx = prev.findIndex((a) => a.id === actionWithPath.id);
                if (idx >= 0) { const updated = [...prev]; updated[idx] = actionWithPath; return updated; }
                return [...prev, actionWithPath];
              });
              setModal(null);
            }}
            onClose={() => setModal(null)}
          />
        )}
        <SoulModal
          open={soulModalOpen}
          onClose={() => setSoulModalOpen(false)}
          onCreated={() => setSoulModalOpen(false)}
          createUrl={plugin ? '/dsh-femo/souls' : getBackendBaseUrl() + '/api/souls/create'}
        />
        {/* 导入清单（第一级，2026-09-11）：**特意不传 onBrowse**——手机端的
            系统文件对话框开在电脑屏幕上，按了也够不着，留着只会让人以为按坏了。
            挂在这里而不是 MobileLayout 内部：zIndex 9999 的 fixed 浮层盖住
            移动端布局（900）与运行守卫（1000）即可，无需穿参数。 */}
        <FemoFileList
          open={femoFileOpen}
          files={femoFileList}
          loading={femoFileLoading}
          error={femoFileError}
          busyPath={femoFileBusyPath}
          onPick={handlePickFromList}
          onClose={() => setFemoFileOpen(false)}
        />
      </ErrorBoundary>
    );
  }

  // ══════════════════════════════════════════
  // 桌面端原有渲染（保持完全不变）
  // ══════════════════════════════════════════
  return (
    <ErrorBoundary>
      <FontStyle scoped={plugin} />
      <div
        ref={editorRootRef}
        data-femo-theme={theme}
        style={{
          display: 'flex',
          // 插件模式整体缩放锁定 75%（zoom 连布局尺寸一起缩；
          // 弹窗 fixed 相对本容器定位，inset:0 跟随缩放）。
          width: '100%',
          height: plugin ? '100%' : '100vh',
          zoom: plugin ? 0.75 : 1,
          background: 'var(--femo-app-bg)',
          fontFamily: 'var(--femo-font-sans)',
          overflow: 'hidden',
        }}
      >
        {/* ── LEFT SIDEBAR（258 → 232 = 缩窄 10%）── */}
        <div
          style={{
            width: 232,
            background: 'var(--femo-panel-bg)',
            borderRight: 'var(--femo-border-w) solid var(--femo-border)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            zIndex: 10,
            position: 'relative', // 调试窗口浮层的定位锚（absolute inset:0 盖住边栏）
          }}
        >
          <div
            style={{
              height: 50,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: '0 16px',
              borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontWeight: 900,
                fontSize: 18,
                color: 'var(--femo-text-1)',
                letterSpacing: '-0.03em',
              }}
            >
              <span style={{ color: 'var(--femo-primary)' }}>FEMO</span> Studio
            </div>
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--femo-neutral)',
                marginTop: 2,
                letterSpacing: '0.01em',
              }}
            >
              Flow EMerges Opus.
            </div>
          </div>

          <div style={{ display: 'flex', borderBottom: 'var(--femo-border-w) solid var(--femo-border)' }}>
            {[
              ['library', '组件库'],
              ['project', '项目设置'],
            ].map(([k, v]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  flex: 1,
                  padding: '9px 0',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: tab === k ? 'var(--femo-primary)' : 'var(--femo-neutral)',
                  borderBottom: `var(--femo-border-w-selected) solid ${
                    tab === k ? 'var(--femo-primary)' : 'transparent'
                  }`,
                  fontFamily: 'var(--femo-font-sans)',
                  transition: 'all 0.12s',
                }}
              >
                {v}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '13px 13px' }}>
            {tab === 'library' ? (
              <LibPanel
                lib={lib}
                mode={mode}
                locationPath={locationPath}
                allNames={allNames}
                onNew={() => setModal({ type: 'new' })}
                onNewModule={(name) => {
                  const newPath = [...locationPath, name];
                  const newModule = {
                    id: mid(),
                    name,
                    path: newPath,
                    meta: {},
                    code: [],
                    vars: [],
                    nodes: makeDefaultNodes('module'),
                    edges: [],
                  };
                  // 保存当前画布到 flowStore
                  saveCurrentFlow();
                  // 添加新模块到 moduleStore
                  setModuleStore((prev) => [...prev, newModule]);
                  // 将新模块的默认 flow 加入 flowStore
                  setFlowStore((prev) => [
                    ...prev,
                    {
                      path: newPath,
                      nodes: newModule.nodes,
                      edges: newModule.edges,
                    },
                  ]);
                  // 切换路径
                  setLocationPath(newPath);
                  setNodes(newModule.nodes);
                  setEdges(newModule.edges);
                  setFemoDirty(false);
                  // 注意：autoFemo 会自动更新，无需手动 setFemoText
                }}
                onSelectLib={handleSelectLib}
                onAdd={addNode}
                onAddModule={addModuleNode}
                onAddSpecial={addSpecialNode}
                onAddPosition={addPositionNode}
                onEdit={(a) => setModal({ type: 'edit', action: a })}
                onEditModule={editModule}
                onDragStart={handleLibDragStart}
              />
              ) : mode === 'module' ? (
              (() => {
                const currentMod = moduleStore.find(
                  (m) =>
                    m.path.length === locationPath.length &&
                    m.path.every((s, i) => s === locationPath[i])
                );
                if (!currentMod) return <div style={{ color: 'var(--femo-text-4-weak)', fontSize: 12 }}>未找到模块</div>;
                const modAsProj = {
                  ...currentMod.meta,
                  name: currentMod.name,
                  vars: currentMod.vars || [],
                  code: currentMod.code || [],
                  actors: [],
                };
                return (
                  <ProjPanel
                    proj={modAsProj}
                    actorNames={[]}
                    onChange={(newData) => {
                      const { name, vars, code, actors, ...meta } = newData;
                      setModuleStore((prev) =>
                        prev.map((m) =>
                          m.path.length === locationPath.length &&
                          m.path.every((s, i) => s === locationPath[i])
                            ? { ...m, name: name || m.name, meta, vars: vars || [], code: code || [] }
                            : m
                        )
                      );
                    }}
                  />
                );
              })()
            ) : (
              <ProjPanel
                proj={proj}
                actorNames={(proj.actors || []).map((a) =>
                  a.name.replace('@', '')
                )}
                onChange={setProj}
              />
            )}
          </div>

          {/* ── 底部工具栏 ── */}
          <div style={{
            borderTop: 'var(--femo-border-w) solid var(--femo-border)',
            padding: '10px 13px',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}>
            {/* 底部三键（2026-09-08）：与手机端设置三键同套配方——等宽 flex:1 1 0 +
                FA 图标（FaPalette 主题 / FaUserPlus 新建SOUL / FaTerminal 调试）+
                minHeight 30 芯片家族高度 + 文字段省略号兜底；桌面端有指针，反馈走
                hover 提亮 + 按压回缩（.femo-setting-btn，FontStyle 全局块）。
                顺序与手机端对齐：主题 → 新建 SOUL → 调试。红点内移防裁剪。 */}
            <button
              onClick={cycleTheme}
              title={`主题：${FEMO_THEMES.find((t) => t.id === themeSel)?.desc || themeSel}（点击切换）`}
              className="femo-setting-btn"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                minHeight: 30, boxSizing: 'border-box',
                padding: '6px 8px', borderRadius: 'var(--femo-radius-md)',
                fontSize: 11, fontWeight: 600,
                fontFamily: 'var(--femo-font-sans)',
                cursor: 'pointer', transition: 'all 0.12s',
                border: 'var(--femo-border-w) solid var(--femo-border-strong)',
                background: 'var(--femo-bg)',
                color: 'var(--femo-text-2)',
                flex: '1 1 0', minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <FaPalette size={12} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                {FEMO_THEMES.find((t) => t.id === themeSel)?.name || themeSel}
              </span>
            </button>
            <button
              onClick={() => { setSoulForm({ soul_id: '', soul_name: '', description: '' }); setSoulFormError(''); setSoulModalOpen(true); }}
              title="新建 SOUL"
              className="femo-setting-btn"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                minHeight: 30, boxSizing: 'border-box',
                padding: '6px 8px', borderRadius: 'var(--femo-radius-md)',
                fontSize: 11, fontWeight: 600,
                fontFamily: 'var(--femo-font-sans)',
                cursor: 'pointer', transition: 'all 0.12s',
                border: 'var(--femo-border-w) solid var(--femo-border-strong)',
                background: 'var(--femo-bg)',
                color: 'var(--femo-text-2)',
                flex: '1 1 0', minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <FaUserPlus size={12} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>新建 SOUL</span>
            </button>
            <button
              onClick={() => setDebugOpen(true)}
              title="调试窗口：后端运行信息与报错的常驻日志流（新状态把旧记录刷下去）"
              className="femo-setting-btn"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                minHeight: 30, boxSizing: 'border-box',
                padding: '6px 8px', borderRadius: 'var(--femo-radius-md)',
                fontSize: 11, fontWeight: 600,
                fontFamily: 'var(--femo-font-sans)',
                cursor: 'pointer', transition: 'all 0.12s',
                border: 'var(--femo-border-w) solid var(--femo-border-strong)',
                background: 'var(--femo-bg)',
                color: 'var(--femo-text-2)',
                flex: '1 1 0', minWidth: 0,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <FaTerminal size={12} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>调试</span>
              {debugLog.some((e) => e.level === 'error') && (
                <span
                  style={{
                    position: 'absolute',
                    top: 3,
                    right: 3,
                    width: 8,
                    height: 8,
                    borderRadius: 'var(--femo-radius-pill)',
                    background: 'var(--femo-danger)',
                    border: '1.5px solid var(--femo-bg)',
                  }}
                />
              )}
            </button>
          </div>

          {/* ── 调试窗口浮层：盖住整个边栏（不遮画布/编辑器）── */}
          {debugOpen && (
            <DebugPanel
              entries={debugLog}
              onClose={() => setDebugOpen(false)}
              onClear={() => setDebugLog([])}
              compilerEntries={compilerLog}
              onClearCompiler={() => setCompilerLog([])}
              femogenEntries={femogenLog}
              onClearFemogen={clearFemogenLog}
              hostEntries={hostLog}
              onClearHost={() => setHostLog([])}
              onCompile={handleDebugRun}
              compiling={debugRunning}
            />
          )}
        </div>

        {/* ── CENTER ── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}
        >
          {/* Toolbar */}
          <div
            style={{
              height: 50,
              position: 'relative', // 导出保存回执 toast 的定位锚点
              background: 'var(--femo-panel-bg)',
              borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11.5, color: 'var(--femo-text-3)', fontWeight: 600 }}>
              位置
            </span>
            <button
              onClick={() => {
                if (
                  locationPath.length !== 1 ||
                  locationPath[0] !== 'mainflow'
                ) {
                  saveCurrentFlow();
                  setLocationPath(['mainflow']);
                }
              }}
              disabled={
                locationPath.length === 1 && locationPath[0] === 'mainflow'
              }
              style={{
                padding: '4px 13px',
                borderRadius: 'var(--femo-radius-sm)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: 'var(--femo-font-sans)',
                border: `var(--femo-border-w-strong) solid ${
                  mode === 'mainflow' ? 'var(--femo-primary)' : 'var(--femo-border-strong)'
                }`,
                background: mode === 'mainflow' ? 'var(--femo-primary-soft-2)' : 'var(--femo-surface)',
                color: mode === 'mainflow' ? 'var(--femo-primary)' : 'var(--femo-text-3)',
                opacity: mode === 'mainflow' ? 0.7 : 1,
              }}
            >
              主流程
            </button>
            {locationPath.map((seg, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 && (
                  <span
                    style={{ color: 'var(--femo-text-4)', fontSize: 12, fontWeight: 600 }}
                  >
                    &gt;
                  </span>
                )}
                {idx === 0 ? null : (
                  <button
                    onClick={() => {
                      saveCurrentFlow();
                      const newPath = locationPath.slice(0, idx + 1);
                      setLocationPath(newPath);
                    }}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 'var(--femo-radius-sm)',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 700,
                      border: `var(--femo-border-w-strong) solid var(--femo-border-strong)`,
                      background: 'var(--femo-surface)',
                      color: 'var(--femo-text-3)',
                    }}
                  >
                    {seg}
                  </button>
                )}
              </React.Fragment>
            ))}
            {mode === 'module' && (
              <button
                onClick={() => {
                  saveCurrentFlow();
                  const newPath = locationPath.slice(0, -1);
                  setLocationPath(newPath);
                }}
                style={{
                  padding: '4px 12px',
                  fontSize: 11,
                  background: 'var(--femo-border-strong)',
                  border: 'none',
                  borderRadius: 'var(--femo-radius-md)',
                  cursor: 'pointer',
                }}
              >
                返回上级
              </button>
            )}{' '}
            <div style={{ flex: 1 }} />
            {/* 导出保存回执 toast：锚在工具栏右下方（保存按钮正下方），4s 自动消失。 */}
            {exportToast !== null && (
              <div
                key={exportToast.id}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 12,
                  zIndex: 90,
                  maxWidth: 'min(560px, 100%)',
                  padding: '7px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontWeight: 600,
                  wordBreak: 'break-all',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                  background: 'var(--femo-panel-bg)',
                  border: '1px solid var(--femo-success, #3ca050)',
                  color: 'var(--femo-success, #3ca050)',
                }}
              >
                {exportToast.text}
              </div>
            )}
            {/* 停止反馈条（2026-09-07 静默吞错修复）：error=请求失败（红）；
                warning=受理未确认/幂等无操作（黄）。锚在 exportToast 上方，
                8s 自动消失（showStopNotice 统一管理）。 */}
            {stopNotice !== null && (
              <div
                key={stopNotice.id}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 12,
                  transform: 'translateY(-44px)',
                  zIndex: 91,
                  maxWidth: 'min(560px, 100%)',
                  padding: '7px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontWeight: 600,
                  wordBreak: 'break-all',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                  background: 'var(--femo-panel-bg)',
                  border: `1px solid ${stopNotice.level === 'error' ? 'var(--femo-danger, #d24b4b)' : stopNotice.level === 'info' ? 'var(--femo-ok, #4b9ad2)' : 'var(--femo-warn, #d29a4b)'}`,
                  color: stopNotice.level === 'error' ? 'var(--femo-danger, #d24b4b)' : stopNotice.level === 'info' ? 'var(--femo-ok, #4b9ad2)' : 'var(--femo-warn, #d29a4b)',
                }}
              >
                {stopNotice.level === 'error' ? '⛔ ' : stopNotice.level === 'info' ? '✅ ' : '⚠️ '}
                {stopNotice.text}
              </div>
            )}
            {/* 运行控制（2026-09-11 定型：**按钮恒定，只变展示**）——三枚按钮各自
                钉死一个动作/一套样式/一句文案，从生到死不变；运行阶段只决定渲染
                哪几枚（三枚与「导入/导出」同为 ToolChip 家族：同高度/内边距/圆角/
                字号 + 各带一枚 FA 图标，只靠色调分语义）：
                  绿「运行」(FaPlay)      = fresh_start（reset:true 从头开演；未开跑与挂起态都出现）
                  红「停止」(FaStop)      = stop（只在跑的时候出现）
                  琥珀「继续」(FaForward) = resume（从断点续跑；只在 stop 之后的挂起态出现）
                挂起态顺序=常驻的运行键在前、挂起专属的继续键在后。暂停按钮删除
                （引擎无暂停语义——stop=suspended 可续跑）。状态实时化=run_state
                快照驱动。 */}
            {(flowStatus === 'idle' || flowStatus === 'paused') && (
              enginePending ? (
                <ToolChip icon={FaSpinner} tone="neutral" disabled title="引擎冷启动中（bridge 未就绪）——就绪后即可开演">
                  引擎启动中…
                </ToolChip>
              ) : (
                <ToolChip
                  icon={FaPlay}
                  tone="success"
                  onClick={() => handleRunWorkflow(undefined, 'human', { reset: true })}
                  title="从头开演整个剧本（fresh start；挂起的一场会自动存档）"
                >
                  运行
                </ToolChip>
              )
            )}
            {flowStatus === 'running' && (
              <ToolChip
                icon={FaStop}
                tone="danger"
                onClick={handleStopWorkflow}
                title="停止（可续跑：断点保留，之后可点「继续」接着跑）"
              >
                停止
              </ToolChip>
            )}
            {flowStatus === 'paused' && (
              <ToolChip
                icon={FaForward}
                tone="warning"
                onClick={handleResumeWorkflow}
                title="继续（从断点续跑）"
              >
                继续
              </ToolChip>
            )}
            {/* 文件读写（2026-09-11 用户点名调序：从运行控制左侧移到右侧，与手机端
                标题栏同序；同日工具栏统一重造：与运行控制同款芯片、同带 FA 图标）。
                隐藏 file input 跟导入键一起走；导出回执 toast 仍锚在工具栏右下方。 */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".femo"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <ToolChip
              icon={FaFolderOpen}
              tone="neutral"
              onClick={handleToolbarImport}
              title="导入 .femo（打开本地剧本文件）"
            >
              导入
            </ToolChip>
            <ToolChip
              icon={FaFloppyDisk}
              tone="neutral"
              onClick={handleToolbarExport}
              disabled={exportBusy}
              title={exportBusy ? '保存中…' : '导出 .femo（把当前剧本保存到本地）'}
            >
              {exportBusy ? '保存中…' : '导出'}
            </ToolChip>
            {/* 编译（零 token 干跑）入口 2026-09-08 迁入调试窗头部——
                工具栏位置退役：编译的日志就显示在调试窗，按钮放窗里语义更顺，
                工具栏只保留运行控制与文件读写。 */}
          </div>

          {/* Canvas */}
          <div
            ref={cvRef}
            style={{
              flex: 1,
              position: 'relative',
              overflow: 'hidden',

              overscrollBehaviorX: 'contain',
              overscrollBehaviorY: 'contain', /*禁止浏览器返回手势的冲突*/

              backgroundImage:
                'var(--femo-canvas-dots)',
              backgroundSize: '22px 22px',
              cursor: isPanning
                ? 'grabbing'
                : conn
                ? 'crosshair'
                : 'default',
            }}
            onMouseMove={onMM}
            onMouseUp={onMU}
            onMouseDown={onCanvasDown}
            onWheel={handleWheel}

            onMouseLeave={() => {
              setDrag(null);
              setConn(null);
              setIsPanning(false);
              isDraggingRef.current = false;
              isMouseDownRef.current = false;
            }}

            onDragOver={handleCanvasDragOver}
            onDrop={handleCanvasDrop}
          >
            {/* ★ 淡入动效容器 */}
            <div
              data-canvas-bg="true"
              style={{
                opacity: canvasOpacity,
                transition: 'opacity 0.2s ease',
                position: 'absolute',
                inset: 0,
              }}
            >
              {/* Transform wrapper for panning */}
              <div
                data-canvas-bg="true"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                  transformOrigin: '0 0',
                  position: 'absolute',
                  inset: 0,
                }}
              >
              {/* SVG layer */}
<svg
  style={{
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    overflow: 'visible',
    zIndex: 24,
  }}
>
                <defs>
                  {[
                    ['a', 'var(--femo-edge-flow)'],
                    ['as', 'var(--femo-edge-sel)'],
                    ['a_for', 'var(--femo-edge)'],
                    ['al', 'var(--femo-danger)'],
                    ['aj', 'var(--femo-warning)'],
                  ].map(([id, col]) => (
                    <marker
                      key={id}
                      id={id}
                      markerWidth="8"
                      markerHeight="6"
                      refX="7"
                      refY="3"
                      orient="auto"
                    >
                      <polygon points="0 0, 8 3, 0 6" fill={col} />
                    </marker>
                  ))}
                  {/* 流光渐变定义已于 round35 随 v8 多层 dash 方案移除（无引用） */}
                </defs>

                {sortedEdges.map((e) => {
                  const s = nm.get(e.src),
                    t = nm.get(e.tgt);
                  if (!s || !t) return null;

                  const isBack = backEdges.has(e.id);
                  const isCycleEdge = allCycleEdges.has(e.id);
                  
                  // 自环边特殊处理（不走 computeEdgeGeometry）
                  if (e.src === e.tgt) {
                    const ss = getNodeSize(s);
                    const cx = s.x + ss.w / 2;
                    const cy = s.y + ss.h / 2;
                    const startX = s.x + ss.w;
                    const startY = cy;
                    const endX = cx;
                    const endY = s.y;
                    const midX = cx + ss.w * 0.8;
                    const midY = s.y - ss.h * 0.4;
                    const pathD = `M${startX},${startY} C${midX},${midY} ${midX},${midY} ${endX},${endY}`;
                    const isSel = sel?.type === 'edge' && sel.id === e.id;
                    console.log('[SVG self-loop] edge.id=', e.id, 'pathD=', pathD);
                    return (
                      <g key={e.id}>
                        <path
                          d={pathD}
                          fill="none"
                          stroke="transparent"
                          data-edge-id={e.id}
                          strokeWidth={18}
                          style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                          onMouseDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setSel({ type: 'edge', id: e.id });
                          }}
                        />
                        <path
                          d={pathD}
                          fill="none"
                          stroke={isSel ? 'var(--femo-edge-sel)' : 'var(--femo-edge)'}
                          markerEnd="url(#a)"
                          style={{ strokeWidth: isSel ? 'var(--femo-edge-w-sel)' : 'var(--femo-edge-w)' }}
                        />
                        {/* 流光：回边同为金线 */}
                        <EdgeShimmer d={pathD} w={1} />
                      </g>
                    );
                  }

                  // ── PAR 边判断 ──
                  const isParCycle = parCycleEdges.has(e.id);
                  const isParBroken = parBrokenEdges.has(e.id);
                  const isParEdge = isParCycle || isParBroken;

                  // ── 统一几何计算 ──
                  const geo = computeEdgeGeometry(e, s, t, {
                    isCycleEdge,
                    isParEdge,
                    parLineCount: 5,
                    parGap: 6,
                    portEdgeGroupMap,
                  });
                  if (!geo) return null;

                  // console.log('[SVG edge]', e.id, 'cond=', e.cond, 'isBack=', isBack,
                  //  'labelPos=', geo.labelPos, 'srcDir=', geo.srcDir, 'tgtDir=', geo.tgtDir,
                  //   'pathDs count=', geo.pathDs.length, 'midIdx=', geo.midIdx);

                  // ── 颜色与样式 ──
                  const isSel = sel?.type === 'edge' && sel.id === e.id;
                  const isForBroken = forBrokenEdges.has(e.id) && !isCycleEdge;
                  const isForOutEdge = nodes.some(n => (n.type === 'for_out' || n.type === 'par_out') && (n.id === e.src || n.id === e.tgt));
                  const isForBrokenFinal = isForBroken && !isForOutEdge;

                  const col = isParBroken ? 'var(--femo-danger)' :
                              isParCycle ? 'var(--femo-edge)' :
                              isForOutEdge ? 'var(--femo-edge)' :
                              isCycleEdge ? 'var(--femo-edge)' :
                              isForBrokenFinal ? 'var(--femo-danger)' :
                              isSel ? 'var(--femo-edge-sel)' :
                              'var(--femo-edge-flow)';
                  const mkr = isParBroken ? 'al' :
                              isParCycle ? 'a_for' :
                              isForBrokenFinal ? 'al' :
                              isSel ? 'as' :
                              (isForOutEdge || isCycleEdge) ? 'a_for' :
                              'a';
                  const dashArray = (isParBroken || isForBrokenFinal) ? '5,3' : 'none';

                  return (
                    <g key={e.id}>
                      {/* 透明点击区域：使用中间那条线 */}
                      <path
                        d={geo.pathDs[geo.midIdx]}
                        fill="none"
                        stroke="transparent"
                        data-edge-id={e.id}
                        strokeWidth={isParEdge ? 24 : 18}
                        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSel({ type: 'edge', id: e.id });
                        }}
                      />
                      {/* 可见线条：多条平行 */}
                      {geo.pathDs.map((pathD, i) => (
                        <g key={i}>
                          <path
                            d={pathD}
                            fill="none"
                            stroke={col}
                            strokeDasharray={dashArray}
                            markerEnd={`url(#${mkr})`}
                            style={{ pointerEvents: 'none', strokeWidth: isSel ? 'var(--femo-edge-w-sel)' : 'var(--femo-edge-w)' }}
                          />
                          {/* 流光：仅金线（红色语义边不发光） */}
                          {!isParBroken && !isForBrokenFinal && <EdgeShimmer d={pathD} w={1} />}
                        </g>
                      ))}
                      {/* 条件标签：所有边都显示（包括回边），无白色背景框，用贝塞尔中点 */}
                      {e.cond && (
                        <text
                          x={geo.labelPos.x}
                          y={geo.labelPos.y + 4.5}
                          textAnchor="middle"
                          fontSize={9.5}
                          fontWeight={700}
                          fill={col}
                          fontFamily="var(--femo-font-mono)"
                          style={{ pointerEvents: 'none' }}
                        >
                          {e.cond}
                        </text>
                      )}
                      {/* 源点圆点：多边同源时显示 */}
                      {!isBack &&
                        edges.filter((x) => x.src === e.src).length > 1 && (() => {
                          const sp = geo.srcPorts[geo.midIdx];
                          return sp ? (
                            <circle
                              cx={sp.x}
                              cy={sp.y}
                              r={4}
                              fill="var(--femo-primary)"
                              style={{ pointerEvents: 'none' }}
                            />
                          ) : null;
                        })()}
                    </g>
                  );
                })}

                {/* Temp connecting line */}
                {conn &&
                  (() => {
                    const pathD = getTempConnLine();
                    return pathD ? (
                      <path
                        d={pathD}
                        fill="none"
                        stroke="var(--femo-primary)"
                        strokeWidth={2}
                        strokeDasharray="6,3"
                        style={{ pointerEvents: 'none' }}
                      />
                    ) : null;
                  })()}
              </svg>

              {/* Nodes */}
              {nodes.map((n) => {
                const enrichedNode = n.type === 'action'
                  ? { ...n, action: actionMap.get(n.actionId) }
                  : n;
                const commonProps = {
                  sel: sel?.type === 'node' && sel.id === enrichedNode.id,
                  onBody: (e) => {
                    e.stopPropagation();
                    // 如果鼠标上正粘着拖拽/连线/平移状态，单击任意节点直接清除
                    if (drag || isPanning || conn) {
                      setDrag(null);
                      setIsPanning(false);
                      setConn(null);
                      return;
                    }
                    setSel({ type: 'node', id: enrichedNode.id });
                    setDrag({
                      id: enrichedNode.id,
                      sx: e.clientX,
                      sy: e.clientY,
                      ox: enrichedNode.x,
                      oy: enrichedNode.y,
                    });
                  },
                  onPortDown: (e, dir) => handlePortDown(e, enrichedNode.id, dir),
                  onPortUp: (e, dir) => handlePortUp(e, enrichedNode.id, dir),
                  onBodyMouseUp: (e) => handleBodyMouseUp(e, enrichedNode.id),
                };

                if (enrichedNode.type === 'special') {
                  return (
                    <SpecialNodeView
                      key={enrichedNode.id}
                      node={enrichedNode}
                      {...commonProps}
                      isActive={activeNodeIds.has(enrichedNode.id)}
                    />
                  );
                }
// --- 原有 for_out 逻辑 ---
if (enrichedNode.type === 'for_out') {
  const isSel = sel?.type === 'node' && sel.id === enrichedNode.id;
  const motherNode = enrichedNode.forNodeId ? nm.get(enrichedNode.forNodeId) : null;
  return (
    <ForOutNodeView
      key={enrichedNode.id}
      node={enrichedNode}
      sel={isSel}
      forSpecialType={motherNode?.specialType || 'FOR'}
      onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)}
      onBubbleClick={(nodeId) => {
        setDrag(null);
        setConn(null);
        setIsPanning(false);
        setSel({ type: 'node', id: nodeId });
      }}
      onPortDown={(e, dir, x, y) => handlePortDown(e, enrichedNode.id, dir, x, y)}
      onPortUp={(e, dir, x, y) => handlePortUp(e, enrichedNode.id, dir)}
    />
  );
}

// --- 新增 par_out 逻辑 ---
if (enrichedNode.type === 'par_out') {
  const isSel = sel?.type === 'node' && sel.id === enrichedNode.id;
  return (
    <ParOutNodeView
      key={enrichedNode.id}
      node={enrichedNode}
      sel={isSel}
      onBody={(e) => {
        e.stopPropagation();
        if (drag || isPanning || conn) {
          setDrag(null); setIsPanning(false); setConn(null);
          return;
        }
        setSel({ type: 'node', id: enrichedNode.id });
        setDrag({ id: enrichedNode.id, sx: e.clientX, sy: e.clientY, ox: enrichedNode.x, oy: enrichedNode.y });
      }}
      onPortDown={(e, dir) => handlePortDown(e, enrichedNode.id, dir)}
      onPortUp={(e, dir) => handlePortUp(e, enrichedNode.id, dir)}
      onBodyMouseUp={(e) => handleBodyMouseUp(e, enrichedNode.id)}
    />
  );
}
                if (enrichedNode.type === 'position') {
                  return (
                    <PositionNodeView key={enrichedNode.id} node={enrichedNode} {...commonProps} />
                  );
                }
                return (
                  <ActionNodeView
                    key={enrichedNode.id}
                    node={enrichedNode}
                    {...commonProps}
                    onBubbleClick={handleBubbleClick}
                    nodeState={nodeStates[enrichedNode.id]}
                    isActive={activeNodeIds.has(enrichedNode.id)}
                    errorNodeIds={errorNodeIds}
                    onDbl={() => {
                      if (enrichedNode.type === 'action' && enrichedNode.action) {
                        setModal({
                          type: 'editNode',
                          action: enrichedNode.action,
                          nodeId: enrichedNode.id,
                        });
                      } else if (enrichedNode.type === 'module') {
                        const mod = enrichedNode.modDef;
                        if (mod) editModule(mod);
                      }
                    }}
                  />
                );
              })}

              {/* Empty state hint */}
              {nodes.filter((n) => n.type !== 'special').length === 0 &&
                !conn && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        color: 'var(--femo-neutral)',
                        fontWeight: 600,
                      }}
                    >
                      从组件库添加 Action 到画布
                    </div>
                    <div
                      style={{ fontSize: 11.5, color: 'var(--femo-text-4-weak)', marginTop: 6 }}
                    >
                      点击节点端口连线 · 双击编辑 · Space+拖动平移画布 · Del
                      删除 · 拖拽组件到画布
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div
          style={{
            width: rightPanelWidth,
            background: 'var(--femo-panel-bg)',
            borderLeft: 'var(--femo-border-w) solid var(--femo-border)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            position: 'relative',
          }}
        >
          {/* 拖拽手柄 */}
          <div
            onMouseDown={() => setIsResizingRight(true)}
            style={{
              position: 'absolute',
              left: -4,
              top: 0,
              bottom: 0,
              width: 8,
              cursor: 'col-resize',
              zIndex: 20,
            }}
          />
          <div
            style={{
              padding: '14px 16px',
              borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
              minHeight: 160,
            }}
          >
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 800,
                color: 'var(--femo-neutral)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 13,
              }}
            >
              {selNode ? '节点属性' : selEdge ? '连线属性' : '属性面板'}
            </div>

            {selNode ? (
              <>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: 'var(--femo-text-1)',
                    marginBottom: 10,
                  }}
                >
                  {selNode.label}
                </div>
                {selNode.type === 'special' ? (
                  <>
                    <PR k="类型" v={selNode.specialType} />
                    <PR k="类别" v="特殊节点" />
                    {(selNode.specialType === 'FOR' || selNode.specialType === 'PAR') && (
                      <Field label="变化元素" hint={selNode.specialType === 'PAR' ? '并行遍历列表' : '列表全部循环一遍后走出口'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 12.5, color: 'var(--femo-text-2)', fontWeight: 600 }}>
                            {selNode.specialType === 'PAR' ? 'par' : 'for'}
                          </span>
                          <input
                            value={selNode.forCondition || ''}
                            onChange={(e) =>
                              setNodes((p) =>
                                p.map((n) =>
                                  n.id === selNode.id
                                    ? { ...n, forCondition: e.target.value }
                                    : n
                                )
                              )
                            }
                            placeholder={selNode.specialType === 'PAR' ? '@coder in coders' : '@wolf in allWolves'}
                            style={{ ...inp, flex: 1 }}
                          />
                        </div>
                      </Field>
                    )}
                    {(selNode.specialType === 'START' ||
                      selNode.specialType === 'IN') && (
                      <div
                        style={{
                          margin: '8px 0',
                          padding: '5px 8px',
                          background: 'var(--femo-success-soft)',
                          borderRadius: 'var(--femo-radius-sm)',
                          fontSize: 11,
                          color: 'var(--femo-success-strong)',
                          fontWeight: 700,
                        }}
                      >
                        入口节点（唯一）
                      </div>
                    )}
                    {SINK_ONLY.has(selNode.specialType) && (
                      <div
                        style={{
                          margin: '8px 0',
                          padding: '5px 8px',
                          background: 'var(--femo-danger-soft)',
                          borderRadius: 'var(--femo-radius-sm)',
                          fontSize: 11,
                          color: 'var(--femo-danger)',
                          fontWeight: 700,
                        }}
                      >
                        终端节点（仅入）
                      </div>
                    )}
                  </>
                ) : selNode.type === 'position' ? (
                  <>
                    <PR k="类别" v="空节点 (POSITION)" />
                    <div
                      style={{
                        margin: '8px 0',
                        padding: '5px 8px',
                        background: 'var(--femo-bg)',
                        borderRadius: 'var(--femo-radius-sm)',
                        fontSize: 11,
                        color: 'var(--femo-neutral)',
                        fontWeight: 700,
                      }}
                    >
                      仅占位，无内容
                    </div>
                  </>
                ) : (
                  <>
                    {selNode.action ? (
                      <>
                        {selNode.label && (
                          <PR k="节点名" v={selNode.label.replace(/[\[\]]/g, '')} />
                        )}
                        <PR k="Action 名" v={selNode.action.name || '?'} />
                        <PR
                          k="类型"
                          v={`@${selNode.action.executorType || 'ai'}`}
                        />
                        {selNode.action.executorActor && (
                          <PR k="执行者" v={selNode.action.executorActor} />
                        )}
                        {selNode.action.scope && (
                          <PR k="Scope" v={selNode.action.scope} />
                        )}
                        {selNode.action.outVars && (
                          <PR k="out" v={selNode.action.outVars} />
                        )}
                      </>
                    ) : null}
                    {selNode.type === 'module' && (
                      <PR k="引用" v={`&${selNode.modRef}`} />
                    )}
                  </>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  {selNode.type === 'action' && selNode.action && (
                    <button
                      onClick={() =>
                        setModal({
                          type: 'editNode',
                          action: selNode.action,
                          nodeId: selNode.id,
                        })
                      }
                      style={{
                        ...btnS,
                        flex: 1,
                        padding: '5px 0',
                        fontSize: 11.5,
                      }}
                    >
                      编辑
                    </button>
                  )}
                  {!(
                    selNode.type === 'special' &&
                    (selNode.specialType === 'START' ||
                      selNode.specialType === 'IN')
                  ) && (
                    <button
                      onClick={() => {
                        if (
                          selNode.type === 'special' &&
                          (selNode.specialType === 'END' ||
                            selNode.specialType === 'OUT')
                        ) {
                          const sameType = nodes.filter(
                            (n) =>
                              n.type === 'special' &&
                              n.specialType === selNode.specialType
                          );
                          if (sameType.length <= 1) return;
                        }
                        deleteNode(selNode.id);
                      }}
                      style={{
                        ...btnS,
                        flex: 1,
                        padding: '5px 0',
                        fontSize: 11.5,
                        color:
                          selNode.type === 'special' &&
                          (selNode.specialType === 'START' ||
                            selNode.specialType === 'IN')
                            ? 'var(--femo-text-4-weak)'
                            : 'var(--femo-danger)',
                        borderColor:
                          selNode.type === 'special' &&
                          (selNode.specialType === 'START' ||
                            selNode.specialType === 'IN')
                            ? 'var(--femo-border)'
                            : 'var(--femo-danger-border)',
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              </>
            ) : selEdge ? (
              <>
                <PR k="来源" v={nm.get(selEdge.src)?.label || '?'} />
                <PR k="目标" v={nm.get(selEdge.tgt)?.label || '?'} />
                {backEdges.has(selEdge.id) && (
                  <div
                    style={{
                      margin: '8px 0',
                      padding: '5px 8px',
                      background: 'var(--femo-danger-soft)',
                      borderRadius: 'var(--femo-radius-sm)',
                      fontSize: 11,
                      color: 'var(--femo-danger)',
                      fontWeight: 700,
                    }}
                  >
                    回环检测 -- while 循环
                  </div>
                )}
                {(() => {
                  const inEdges = edges.filter(
                    (e) => e.tgt === selEdge.tgt && !backEdges.has(e.id)
                  );
                  if (inEdges.length > 1) {
                    return (
                      <div
                        style={{
                          margin: '8px 0',
                          padding: '5px 8px',
                          background: 'var(--femo-warning-soft)',
                          borderRadius: 'var(--femo-radius-sm)',
                          fontSize: 11,
                          color: 'var(--femo-warning)',
                          fontWeight: 700,
                        }}
                      >
                        Join 节点 ({inEdges.length} 入口)
                      </div>
                    );
                  }
                  return null;
                })()}
                <Field label="if 条件" hint="如 game_over == false">
                  <input
                    value={selEdge.cond || ''}
                    onChange={(e) =>
                      setEdges((p) =>
                        p.map((ed) =>
                          ed.id === selEdge.id
                            ? { ...ed, cond: e.target.value }
                            : ed
                        )
                      )
                    }
                    placeholder="留空 = 无条件"
                    style={inp}
                  />
                </Field>
                <button
                  onClick={() => {
                    setEdges((p) => p.filter((e) => e.id !== selEdge.id));
                    setSel(null);
                  }}
                  style={{
                    ...btnS,
                    width: '100%',
                    color: 'var(--femo-danger)',
                    borderColor: 'var(--femo-danger-border)',
                    fontSize: 11.5,
                    padding: '5px 0',
                  }}
                >
                  删除连线
                </button>
              </>
            ) : libSel ? (
              (() => {
                let item = null;
                if (libSel.type === 'action') {
                  item =
                    lib.actions.find((a) => a.id === libSel.id) ||
                    lib.modules
                      .flatMap((m) => m.internalActions || [])
                      .find((a) => a.id === libSel.id);
                } else if (libSel.type === 'module') {
                  item = lib.modules.find((m) => m.id === libSel.id);
                }
                if (!item)
                  return <div style={{ color: 'var(--femo-text-4-weak)' }}>未找到项</div>;
                return (
                  <>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        marginBottom: 10,
                        color: 'var(--femo-text-1)',
                      }}
                    >
                      {libSel.type === 'module' ? `&${item.name}` : item.name}
                    </div>
                    {libSel.type === 'action' ? (
                      <>
                        <PR k="类型" v={`@${item.executorType}`} />
                        {item.executorActor && (
                          <PR k="执行者" v={item.executorActor} />
                        )}
                        {item.scope && <PR k="Scope" v={item.scope} />}
                        {item.outVars && <PR k="out" v={item.outVars} />}
                      </>
                    ) : (
                      <PR k="模块" v={item.name} />
                    )}
                    <button
                      onClick={() => {
                        if (libSel.type === 'action')
                          setModal({ type: 'edit', action: item });
                        else editModule(item);
                      }}
                      style={{ ...btnS, marginTop: 8, width: '100%' }}
                    >
                      编辑
                    </button>
                  </>
                );
              })()
            ) : (
              <div
                style={{ color: 'var(--femo-text-4-weak)', fontSize: 11.5, lineHeight: 1.7 }}
              >
                点击节点或连线查看属性
                <br />
                <span style={{ fontSize: 10.5 }}>双击节点可编辑 Action</span>
              </div>
            )}
          </div>

      {/* FEMO Preview */}
      {plugin && savedPath === undefined && (
        <div style={{
          fontSize: 11,
          color: 'var(--femo-warning-strong)',
          background: 'var(--femo-warning-soft)',
          border: 'var(--femo-border-w) solid var(--femo-warning-border)',
          borderRadius: 'var(--femo-radius-sm)',
          padding: '4px 8px',
          marginBottom: 4,
          lineHeight: 1.4,
        }}>
          ⚠ 剧本未保存。外接依赖文件只支持绝对地址。
        </div>
      )}
      <FemoPreview
        value={femoText}
        onChange={(v) => { setFemoText(v); setFemoDirty(true); }}
        error={femoError}
        warnings={FEMOrnings}
        dirty={femoDirty}
        onApply={handleApplyFemo}
        onRestore={handleRestoreFemo}
        onGraphToFemo={handleGraphToTextCommit}
      />
      </div> {/* 闭合右侧面板 */}

      {/* ── MODAL ── */}
      {modal && (
        <ActionModal
          init={modal.type !== 'new' ? modal.action : null}
          existingNames={[...allNames]}
          isModuleInternal={mode === 'module'}
          onSave={(action) => {
            const actionWithPath = {
              ...action,
              path: action.path || [...locationPath],
            };
            if (modal.type === 'editNode') {
              setNodes((p) =>
                p.map((n) =>
                  n.id === modal.nodeId
                    ? { ...n, label: `[${actionWithPath.name}]` }
                    : n
                )
              );
            } else if (modal.type === 'edit') {
              setNodes((p) =>
                p.map((n) =>
                  n.actionId === actionWithPath.id
                    ? { ...n, label: `[${actionWithPath.name}]` }
                    : n
                )
              );
            } else {
              addNode(actionWithPath);
            }
            // 更新 actionStore
            setActionStore((prev) => {
              const idx = prev.findIndex((a) => a.id === actionWithPath.id);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = actionWithPath;
                return updated;
              } else {
                return [...prev, actionWithPath];
              }
            });
            // ⚡ 已删除 setFemoDirty(false)：原架构下这行是竞态触发点，
            //    现在不再有 autoFemo 自动同步机制，此处无需操作 dirty 状态。
            console.log('[ActionModal onSave] action 已更新, name:', actionWithPath.name);
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
      <BubbleOverlay
        bubbleOverlay={bubbleOverlay}
        nodes={nodes}
        nodeStates={nodeStates}
        humanWaits={humanWaits}
        actionStore={actionStore}
        onClose={handleBubbleClose}
        submitHumanInput={submitHumanInput}
      />


      {/* 运行守卫弹窗：存在未落盘修改时，运行按钮被拦截，让用户选定稿版本 */}
      {runGuard !== null && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            maxWidth: 430, width: 'calc(100% - 48px)', padding: '18px 20px', borderRadius: 12,
            background: 'var(--femo-surface, #fff)', border: '1px solid var(--femo-border, #e0e0e0)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.22)', fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>⚠️ 有未落盘修改</div>
            <div style={{ color: 'var(--femo-text-secondary, #666)', marginBottom: 14 }}>
              {runGuard.textDirty && runGuard.graphDirty
                ? '文本和画布图都被修改过，且互相不统一。'
                : runGuard.textDirty
                  ? '文本被修改过，尚未应用到画布和 record。'
                  : '画布图被修改过，尚未应用到文本和 record。'}
              建议回去按对应的统一按钮（文本生图 / 图生文本）应用你要的版本；
              也可以放弃这些修改，以最后保存的 record 为准直接运行。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setRunGuard(null)}
                style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--femo-border, #ccc)', background: 'transparent', cursor: 'pointer' }}
              >回去核查</button>
              <button
                onClick={discardChangesAndRun}
                style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #d96b2b', background: '#d96b2b', color: '#fff', cursor: 'pointer' }}
              >放弃修改，直接跑</button>
            </div>
          </div>
        </div>
      )}

      {/* SOUL modal: shared by plugin & standalone modes */}
      <SoulModal
        open={soulModalOpen}
        onClose={() => setSoulModalOpen(false)}
        onCreated={(data) => {
          setSoulModalOpen(false);
        }}
        createUrl={plugin ? '/dsh-femo/souls' : getBackendBaseUrl() + '/api/souls/create'}
      />

      {/* 导入清单（第一级，2026-09-11）：桌面端带右上角「浏览…」，按它走原来的
          系统文件对话框；清单只会在插件模式打开（独立模式没有账本）。 */}
      <FemoFileList
        open={femoFileOpen}
        files={femoFileList}
        loading={femoFileLoading}
        error={femoFileError}
        busyPath={femoFileBusyPath}
        onPick={handlePickFromList}
        onBrowse={handleBrowseImport}
        onClose={() => setFemoFileOpen(false)}
      />
    </div> {/* 闭合最外层 flex 容器 */}
    </ErrorBoundary>
  );
});
export default FEMOEditor;
