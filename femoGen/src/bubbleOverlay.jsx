// ═══════════════════════════════════════════════════════════════
// ═══ bubbleOverlay.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { ti, inp, btnP } from './common';

// ── func/assign 气泡的 In/Out 面板（2026-09-07）──
// 运行值来自 func_result/assign_result 事件的 input/output 字段（后端
// FEMO_runtime 落在 ns.ins/ns.outs）；未运行时回退显示 action 静态声明名。

// 从 action 静态声明文本（inMappings/outVars）提取变量名，作未运行时的回退。
// 兼容三种写法：逗号列表（`a, b, c`）、映射行（`local = @day`）、
// 赋值表达式（`count += 1` / `dict.@actor = {}`）与带注解的 out（`x(dropdown, ...)`）。
function parseDeclaredNames(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const names = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const items = /[=(]/.test(line)
      ? [line]
      : line.split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      const m = item.match(/^[\w$\u4e00-\u9fff.@]+/);
      if (m) names.push(m[0]);
    }
  }
  return names;
}

const VAR_VALUE_MAX = 1500;
function formatVarValue(v) {
  let s;
  if (v === null) s = 'null';
  else if (v === undefined) s = '—';
  else if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v, null, 2) ?? String(v); }
    catch { s = String(v); }
  }
  if (s === '') s = '""';
  return s.length > VAR_VALUE_MAX ? s.slice(0, VAR_VALUE_MAX) + ' …' : s;
}

// in/out 区的行：entries=运行值（名字→值），names=静态声明名（未运行的回退）
function VarRows({ entries, names }) {
  const hasEntries = !!entries?.length;
  const hasNames = !!names?.length;
  if (!hasEntries && !hasNames) {
    return (
      <div style={{ fontSize: 11.5, color: 'var(--femo-text-3)' }}>（无）</div>
    );
  }
  const rows = hasEntries
    ? entries.map(([k, v]) => ({ name: k, value: formatVarValue(v) }))
    : names.map((n) => ({ name: n, value: '—' }));
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
          <span
            style={{
              minWidth: 90,
              maxWidth: '40%',
              fontFamily: 'var(--femo-font-mono)',
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--femo-text-2)',
              flexShrink: 0,
              wordBreak: 'break-all',
            }}
          >
            {r.name}:
          </span>
          <span
            style={{
              fontFamily: 'var(--femo-font-mono)',
              fontSize: 12,
              color: 'var(--femo-text-1)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              flex: 1,
            }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// func/assign 浮层的 in/out 面板（2026-09-07）：上半区 in、分割横线、下半区 out。
// 运行值来自 func_result/assign_result 事件的 input/output（ns.ins/ns.outs）；
// 未运行回退显示 action 静态声明名。
function FuncAssignSection({ ns, action, accent }) {
  const insEntries = ns.ins ? Object.entries(ns.ins) : null;
  const outsEntries = ns.outs ? Object.entries(ns.outs) : null;
  const declaredIn = insEntries?.length ? null : parseDeclaredNames(action?.inMappings);
  const declaredOut = outsEntries?.length ? null : parseDeclaredNames(action?.outVars);
  // func 未声明 out 时后端把返回值 repr 进 output 字符串——兜底展示在 out 区
  const showReturnValue =
    !outsEntries?.length && typeof ns.output === 'string' && ns.output.length > 0;
  const isRunning = ns.status === 'running';
  const nothing =
    !insEntries?.length && !outsEntries?.length &&
    !declaredIn.length && !declaredOut.length && !showReturnValue && !isRunning;
  if (nothing) return null;

  const labelChip = {
    display: 'inline-block',
    background: accent + '18',
    color: accent,
    borderRadius: 'var(--femo-radius-sm)',
    padding: '1px 10px',
    fontSize: 11,
    fontWeight: 800,
    fontFamily: 'var(--femo-font-mono)',
    marginBottom: 6,
  };
  const fallbackHintStyle = (
    <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 6, color: 'var(--femo-text-3)' }}>
      （未运行，仅显示声明名）
    </span>
  );
  const inFallback = !insEntries?.length && declaredIn.length > 0;
  const outFallback = !outsEntries?.length && declaredOut.length > 0;

  return (
    <div style={{ marginBottom: 12 }}>
      {/* ── in ── */}
      <div>
        <span style={labelChip}>in</span>
        {inFallback && fallbackHintStyle}
        <VarRows entries={insEntries} names={declaredIn} />
      </div>

      {/* ── 分割横线 ── */}
      <div
        style={{
          height: 1,
          background: 'var(--femo-border)',
          margin: '10px 0 12px',
        }}
      />

      {/* ── out ── */}
      <div>
        <span style={labelChip}>out</span>
        {outFallback && fallbackHintStyle}
        <VarRows entries={outsEntries} names={declaredOut} />
        {showReturnValue && (
          <div
            style={{
              fontFamily: 'var(--femo-font-mono)',
              fontSize: 12,
              color: 'var(--femo-text-1)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {formatVarValue(ns.output)}
          </div>
        )}
      </div>

      {isRunning && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--femo-text-3)', fontWeight: 700 }}>
          ⏳ 运行中…
        </div>
      )}
    </div>
  );
}

function BubbleSection({ title, content, streaming }) {
  if (!content && !streaming) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {title && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--femo-text-3)',
            marginBottom: 4,
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--femo-text-1)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          maxHeight: streaming ? 'none' : 'auto',
        }}
      >
        {content}
        {streaming && <span className="streaming-cursor">|</span>}
      </div>
    </div>
  );
}

function HumanInputSection({ nodeId, onSubmit, outVars, inputError }) {
  const [chatText, setChatText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [varValues, setVarValues] = useState({});

  const handleVarChange = (varName, value) => {
    setVarValues((prev) => ({ ...prev, [varName]: value }));
  };

  const handleSend = async () => {
    const hasChat = chatText.trim();
    const hasVars = Object.values(varValues).some((v) => v && v.trim());
    if (!hasChat && !hasVars) return;
    const assignments = {};
    for (const [k, v] of Object.entries(varValues)) {
      if (v && v.trim()) {
        assignments[k] = v.trim();
      }
    }
    console.log('[HumanInputSection] handleSend:', { nodeId, chatText: chatText.trim(), assignments });
    // 提交失败（onSubmit 返回 false，气泡内会显示红色错误条）时保留输入，
    // 不清空——用户不必重打一遍。
    const ok = await onSubmit(nodeId, chatText.trim(), assignments);
    if (ok !== false) {
      setChatText('');
      setVarValues({});
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    let combined = chatText;
    let readCount = 0;
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target.result;
        if (combined.length > 0 && !combined.endsWith('\n')) combined += '\n';
        combined += `\n====== ${file.name} ======\n${content}\n`;
        readCount++;
        if (readCount === files.length) {
          setChatText(combined);
        }
      };
      reader.onerror = () => {
        readCount++;
        if (readCount === files.length) {
          setChatText(combined);
        }
      };
      reader.readAsText(file);
    });
  };

  const vars = Array.isArray(outVars) ? outVars : [];
  const hasVars = vars.length > 0;
  const VAR_INPUT_WIDTH = 120;

  return (
    <div style={{ marginTop: 8, flexShrink: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--femo-warning)',
          marginBottom: 4,
        }}
      >
        ⏳ 等待人类输入
      </div>
      {inputError && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--femo-danger-strong)',
            background: 'var(--femo-danger-soft)',
            border: 'var(--femo-border-w) solid var(--femo-danger-border)',
            borderRadius: 'var(--femo-radius-sm)',
            padding: '6px 8px',
            marginBottom: 6,
            whiteSpace: 'pre-wrap',
          }}
        >
          ❌ 输入被拒绝：{inputError}
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          border: dragOver ? 'var(--femo-border-w-selected) dashed var(--femo-warning)' : 'var(--femo-border-w-selected) solid transparent',
          borderRadius: 'var(--femo-radius-md)',
          transition: 'border 0.15s',
        }}
      >
        <textarea
          data-field="chatText"
          value={chatText}
          onChange={(e) => setChatText(e.target.value)}
          placeholder="输入回复，或拖拽文件到此处..."
          rows={4}
          style={{
            ...inp,
            resize: 'vertical',
            width: '100%',
            boxSizing: 'border-box',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 6,
          flexWrap: 'wrap',
        }}
      >
        <button style={{ ...btnP }} onClick={handleSend}>
          发送
        </button>
        {hasVars && vars.map((varName) => (
          <div
            key={varName}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--femo-text-3)',
                fontFamily: 'var(--femo-font-mono)',
                whiteSpace: 'nowrap',
              }}
            >
              {varName}:
            </span>
            <input
              data-var={varName}
              value={varValues[varName] || ''}
              onChange={(e) => handleVarChange(varName, e.target.value)}
              placeholder="值/+=1/add(@x)"
              style={{
                ...inp,
                width: `${VAR_INPUT_WIDTH}px`,
                fontSize: 12,
                padding: '3px 6px',
                flexShrink: 0,
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function BubbleOverlay({ bubbleOverlay, nodes, nodeStates, humanWaits, actionStore, onClose, submitHumanInput }) {
  if (!bubbleOverlay) return null;
  const node = nodes.find((n) => n.id === bubbleOverlay.nodeId);
  if (!node || node.type !== 'action') return null;
  const action = actionStore?.find(a => a.id === node.actionId);
  const ns = nodeStates[node.id] || {};
  // 常驻人类等待（par 并发修复 2026-09-07）：来自独立账本 humanWaits。
  // 同一 mind 画布节点被 par 多实例（AI+人类混合）并行时，所有实例事件同名，
  // AI 实例的 node_start/ai_token 会把共享 nodeStates[nodeId] 的 status/type
  // 覆盖成 ai_streaming——旧实现按 ns.status 渲染输入框，导致人类输入框
  // 「闪一下就被 AI 气泡取代」。账本里的等待只有 human_done/提交成功/本场
  // 终态才撤下，AI 实例事件碰不到 → 输入面板常驻。
  const hw = humanWaits?.[node.id] || null;
  // mind 节点按运行时 node_type 判断（node_start 事件写入 ns.type）：
  // 执行者运行时才确定（可能是变量赋值），静态 executorType 无法预判；
  // 未运行（ns.type 空）时回退到静态 executorType。
  const runType = ns.type || action?.executorType;
  const isAI = runType === 'ai';
  const isHuman = runType === 'human';
  const isFuncAssign = runType === 'func' || runType === 'assign';
  const isStreaming = ns.status === 'ai_streaming';
  const c = ti(action?.executorType)?.c || 'var(--femo-neutral)';
  // AI 活动区：有人等待时仅在 AI 实例真在跑/刚跑完（ai_streaming/ai_done）
  // 显示——人类输入第一优先，也不给静态 ai 类型渲染空 AI 区；无人等待时
  // 保持旧口径（含静态 executorType 回退与「（等待输出）」占位）。
  const aiLive = ns.status === 'ai_streaming' || ns.status === 'ai_done';
  const showAI = hw ? aiLive : isAI;
  const scrollRef = useRef(null);
  const userScrolledUpRef = useRef(false);

  // 用户滚动监听：判断是否在底部
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    userScrolledUpRef.current = !atBottom;
  }, []);

  // 自动滚动：仅当用户没有主动上滚时才跟随流式输出；
  // 有人等待时不跟滚（常驻人类卡置顶，AI 流式不抢视图——输入是第一优先级）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledUpRef.current || hw) return;
    el.scrollTop = el.scrollHeight;
  }, [ns.streamingText, ns.output, ns.context, hw]);

  // 浮层弹起时的定位（2026-09-11 用户点名）：**一律拉到长文本最底**——此前
  // 「有人等待 → 定位到顶部常驻卡」，人类节点的 prompt/context 一长就得先往下
  // 翻才看得到最新内容；现在统一到底（输入框本就固定在浮层底部，不受滚动影响）。
  // 用 useLayoutEffect：提交后、绘制前定位，弹起时不会先闪一下顶部再跳到底。
  // hw 变化（等待出现/提交完成）同样重定位到底：语义与"跟最新"一致。
  useLayoutEffect(() => {
    userScrolledUpRef.current = false;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [bubbleOverlay?.nodeId, hw]);

  // 人类等待卡内的提示块（showprompt/prompt/context 读独立账本，与 ns 解耦）
  const hwPromptLabel = hw?.showprompt ? '补充说明' : '提示';

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--femo-mask-soft)',
          zIndex: 2999,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: Math.min(window.innerWidth * 0.6, 640),
          maxHeight: '80vh',
          background: 'var(--femo-surface)',
          borderRadius: 'var(--femo-radius-xl)',
          boxShadow: '0 24px 64px var(--femo-shadow-lg)',
          border: `var(--femo-border-w-selected) solid ${c}`,
          fontFamily: 'var(--femo-font-sans)',
          zIndex: 3000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* 关闭按钮行 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 20px',
            borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                background: c + '18',
                color: c,
                borderRadius: 'var(--femo-radius-sm)',
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'var(--femo-font-mono)',
              }}
            >
              @{action?.executorType || '?'}
            </span>
            <span style={{ fontWeight: 800, color: 'var(--femo-text-1)', fontSize: 16 }}>
              {action?.name || 'Node'}
            </span>
            {hw && (
              <span
                style={{
                  background: 'var(--femo-warning-soft)',
                  color: 'var(--femo-warning)',
                  borderRadius: 'var(--femo-radius-sm)',
                  padding: '2px 8px',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                📌 等待人类输入
              </span>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              background: 'var(--femo-bg-2)',
              border: 'none',
              fontSize: 16,
              cursor: 'pointer',
              color: 'var(--femo-text-2-alt)',
              borderRadius: 'var(--femo-radius-md)',
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.target.style.background = 'var(--femo-bg-hover)')}
            onMouseLeave={(e) => (e.target.style.background = 'var(--femo-bg-2)')}
          >
            ✕
          </button>
        </div>

        {/* 可滚动内容区域 */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
            lineHeight: 1.6,
            fontSize: 13,
            color: 'var(--femo-text-1)',
          }}
        >
          {hw ? (
            <>
              {/* ── 上下文（置顶普通文本，与 AI 节点视图一致）── */}
              {hw.context && (
                <div style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
                  {hw.context}
                </div>
              )}

              {/* ── 常驻人类卡：AI 实例并发输出不顶掉；prompt 独立成卡 ── */}
              <div
                style={{
                  marginBottom: 12,
                  background: 'var(--femo-warning-soft)',
                  border: 'var(--femo-border-w) solid var(--femo-warning)',
                  borderRadius: 'var(--femo-radius-md)',
                  padding: '10px 12px',
                }}
              >
                <div style={{ fontWeight: 700, color: 'var(--femo-warning)', marginBottom: 6, fontSize: 12 }}>
                  ⏳ 等待人类输入{aiLive ? '（AI 并行输出在下方，此卡常驻）' : ''}
                </div>
                {hw.showprompt && (
                  <div style={{ marginBottom: hw.prompt ? 10 : 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--femo-warning-strong)', marginBottom: 4 }}>[节点提示]</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{hw.showprompt}</div>
                  </div>
                )}
                {hw.prompt && (
                  <div>
                    <div style={{ fontWeight: 700, color: 'var(--femo-warning-strong)', marginBottom: 4 }}>[{hwPromptLabel}]</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{hw.prompt}</div>
                  </div>
                )}
              </div>

              {/* ── AI 实例活动区（下方）：par 并发的 AI 分支输出 ── */}
              {showAI && (
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    [{ns.ai_name || 'AI'}]:
                  </div>
                  {ns.status === 'ai_streaming' ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {ns.streamingText || ''}
                      <span className="streaming-cursor">|</span>
                    </div>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {ns.output || '（等待输出）'}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {/* 上下文 */}
              {ns.context && (
                <div style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
                  {ns.context}
                </div>
              )}

              {/* 节点提示（showprompt）—— 仅当存在时显示 */}
              {ns.showprompt && (
                <div style={{ marginBottom: 12, background: 'var(--femo-bg)', padding: '8px 12px', borderRadius: 'var(--femo-radius-md)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 4 }}>[节点提示]</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{ns.showprompt}</div>
                </div>
              )}

              {/* 人类 prompt（独立显示，与 showprompt 分开） */}
              {isHuman && ns.prompt && !ns.showprompt && (
                <div style={{ marginBottom: 12, background: 'var(--femo-bg)', padding: '8px 12px', borderRadius: 'var(--femo-radius-md)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 4 }}>[提示]</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{ns.prompt}</div>
                </div>
              )}
              {isHuman && ns.prompt && ns.showprompt && (
                <div style={{ marginBottom: 12, background: 'var(--femo-bg)', padding: '8px 12px', borderRadius: 'var(--femo-radius-md)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 4 }}>[补充说明]</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{ns.prompt}</div>
                </div>
              )}

              {/* notice：公告本体（node_start 存 prompt，notice_done 存 output） */}
              {runType === 'notice' && (ns.output || ns.prompt) && (
                <div style={{ marginBottom: 12, background: 'var(--femo-bg)', padding: '8px 12px', borderRadius: 'var(--femo-radius-md)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 4 }}>[公告]</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{ns.output || ns.prompt}</div>
                </div>
              )}

              {/* func/assign：in/分割线/out 面板（未运行回退静态声明名） */}
              {isFuncAssign && <FuncAssignSection ns={ns} action={action} accent={c} />}

              {/* AI 输出区域 */}
              {showAI && (
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    [{ns.ai_name || 'AI'}]:
                  </div>
                  {isStreaming ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {ns.streamingText || ''}
                      <span className="streaming-cursor">|</span>
                    </div>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {ns.output || '（等待输出）'}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 人类输入框（固定在底部）：由独立账本驱动——AI 实例事件把 ns 翻成
             ai_streaming 也不再收起输入框；账本为空才回退旧 ns.status 口径 */}
        {(hw || (isHuman && ns.status === 'human_wait')) && (
          <div
            style={{
              flexShrink: 0,
              padding: '12px 20px 20px',
              borderTop: 'var(--femo-border-w) solid var(--femo-border)',
            }}
          >
            <HumanInputSection
              nodeId={node.id}
              onSubmit={submitHumanInput}
              outVars={(hw || ns).outVars || []}
              inputError={(hw || ns).inputError}
            />
          </div>
        )}
      </div>
    </>
  );
}

export { BubbleOverlay, HumanInputSection, BubbleSection };
