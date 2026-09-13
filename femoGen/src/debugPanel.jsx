// ═══════════════════════════════════════════════════════════════
// ═══ debugPanel.jsx — femoGen 调试窗口（后端运行信息/报错的常驻日志流）═══
// ═══════════════════════════════════════════════════════════════
// 设计（2026-09-07 调试窗口正式化，取代「弹完即丢」的临时提示链）：
//  - 此前后端报错三条路都不持久：flow_error 走 alert 阻塞（点掉就没了）、
//    stopNotice 8s / exportToast 4s 自动消失、notify_author 只进 console。
//    这里统一落一条常驻日志，想看可以一直看。
//  - 清空时机不用人操心：新条目插到最前，旧的自然被刷下去；上限 200 条
//    自动淘汰最老的（in-memory，刷新即重来——它是观测面，不是档案）。
//  - 位置：absolute 盖住整个左侧边栏（宿主容器内），不遮画布、不遮编辑器。
//  - 数据只读展示：entries = [{ id, ts, level, kind, text }]，level ∈
//    'error' | 'warn' | 'info'；kind 是来源短标（SSE 事件类型 / '运行' 等）。
//  - 2026-09-08 改版（用户反馈三点）：① 清空按钮退役 → 复制按钮（默认复制
//    全部条目：时间/级别/来源/全文，clipboard API 不可用时回退 execCommand）；
//    ② 条目去卡片化——纯文本一行一条（时间 | [级别来源] | 内容），连续文本
//    可整体选中，不再有软色卡片底与色条；③ 手机端浮层从拖动手柄下方开始
//    （见 mobileView 调用处 top:20），面板开着也能拖高拖矮。
//  - 2026-09-08 编译按钮：头部「复制」旁加「编译」（蓝底，无 emoji）——
//    零 token 编译干跑（femo_debugger FakeHost 替 AI/人类发言），日志直接
//    显示在本面板。onCompile 缺席时按钮不渲染（消费方自行决定是否提供）。
//  - 2026-09-11 清空回归（用户点名）：头部右上角补回「清空」（复制右侧、
//    关闭左侧；中性描边同复制）——09-08 拿它换复制是二选一，现在两个都要：
//    复制走留档、清空走清屏。onClear 缺席时按钮不渲染；日志为空时置灰。
//  - 2026-09-11 行底色（用户点名）：warn 行黄底、error 行红底，info 不上色。
//    级别来自后端而非前端猜——femoCompiler/FEMO_errors.py 四桶分类
//    （FATAL/AGENT→notify_author{severity:fatal|agent_error|agent_giveup}→error；
//    WARNING→severity:'warning'→warn；TOLERANT 不上浮），宿主侧 SSE
//    （flow_error / compile_warnings / ai_retry / node_retry）另供 error/warn；
//    其余运行事件按 info。翻译层在 FemoWorAuto.summarizeDebugEvent。
//    注：09-08 那次「条目去卡片化」撤掉的是**所有**条目的软色底与色条，这里
//    只给 warn/error 两种异常行补底色，正文排版与可整段选中不动。
//  - 2026-09-11 排版改单行（用户点名，紧接着上一条）：两行制（09-08 r3）
//    每条占两行太费竖向空间，改回「时间 [来源] 正文」一条内联流，折行续行
//    顶格（不做表格式分栏对齐）。底色与可整段选中不变。
//  - 2026-09-11 分页签（用户点名）：『剧本』= 以上全部（运行事件/干跑流水）；
//    『编译器』= 后端编译器/引擎运行时的 stdout print 原文 + stderr（[stderr]
//    前缀）——宿主 src/bridge.ts / src/debug-run.ts 逐行转发进 diag-feed
//    （tag 'engine'），前端经 SSE femo_diag 实时收 + 开面板时 GET
//    /dsh-femo/diag-tail 拉历史；
//    『FEMOGen』= 前端 femoGen 自己的 console 输出（femoLog.js 钩 console 镜像）；
//    『Host』= 宿主（投影窗这边）本插件代码的 console 输出（src/host-log.ts 钩
//    console + 调用栈过滤，只认自己人，tag 'host'）。
//    复制/清空按**当前页**生效；错误计数徽标从头部挪到页签上。四页共用同一套
//    行样式与级别底色。后三页的数据来源都在宿主进程，**改宿主那部分要重启 dsh**。

import { useMemo, useState, useCallback } from 'react';

// 级别三态样式（2026-09-11 加 rowBg 行底色，用户点名）：error=红底、warn=黄底，
// info 仍无底色（常规运行信息不上色，免得整屏花）。
// rowBg 用 color-mix 从语义主色派生，而不是直接吃 --femo-*-soft：暗色主题下
// --femo-warning-soft 是 #75603A（莫兰迪灰驼，与 func 底同族），不读作「黄」；
// 从 --femo-warning-strong(#f7ad31) / --femo-danger(#f25a5a) 混 22% 则两套主题
// 都稳定读成黄/红，且底色自动跟随主题（半透明叠在 --femo-panel-bg 上）。
// soft 仍只服务头部错误徽标。
const LEVEL_STYLE = {
  error: {
    dot: 'var(--femo-danger)',
    soft: 'var(--femo-danger-soft)',
    rowBg: 'color-mix(in srgb, var(--femo-danger) 22%, transparent)',
  },
  warn: {
    dot: 'var(--femo-warning-strong)',
    soft: 'var(--femo-warning-soft)',
    rowBg: 'color-mix(in srgb, var(--femo-warning-strong) 22%, transparent)',
  },
  info: { dot: 'var(--femo-neutral)', soft: 'transparent', rowBg: 'transparent' },
};

const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// 宿主页行首的级别标记（src/host-log.ts 给 warn/error 加的前缀）→ 用于上色，
// 并把标记本身收进"来源"栏。只认这四个词，普通行（含 `[runtime]` 这类引擎前缀）
// 不会被误判成级别。
const HOST_LEVEL_RE = /^\[(log|info|warn|error)\]\s*/;

function DebugPanel({
  entries,
  onClose,
  onClear,
  onCompile,
  compiling = false,
  // 编译器页：引擎（编译器/运行时）打印的原始日志（stdout + [stderr] 前缀的 stderr）。
  compilerEntries = [],
  onClearCompiler,
  // FEMOGen 页：femoGen 页面自身产生的日志（femoLog.js 采集）。
  femogenEntries = [],
  onClearFemogen,
  // Host 页：投影窗、会话等宿主侧功能打印的日志（host-log.ts 采集，只收本插件）。
  hostEntries = [],
  onClearHost,
}) {
  // 页签选择是本面板的 UI 私事，不上抛给宿主；默认停在『剧本』（原有信息）。
  const [tab, setTab] = useState('script');
  const errorCount = useMemo(
    () => entries.filter((e) => e.level === 'error').length,
    [entries]
  );
  const femogenErrorCount = useMemo(
    () => femogenEntries.filter((e) => e.level === 'error').length,
    [femogenEntries]
  );
  const hostErrorCount = useMemo(
    () => hostEntries.filter((e) => /^\[error\]/.test(e.text || '')).length,
    [hostEntries]
  );
  // 四页的清单/清除/计数一次列清——加页时只动这里，避免各处 if 分支漂移。
  const TABS = [
    { id: 'script', label: '剧本', list: entries, clear: onClear, errors: errorCount,
      title: '剧本页：运行事件与干跑流水',
      clearTitle: '清空剧本页的日志' },
    { id: 'compiler', label: '编译器', list: compilerEntries, clear: onClearCompiler, errors: 0,
      title: '编译器页：引擎（编译器/运行时）打印的原始日志，含标准输出与错误信息',
      clearTitle: '清空编译器页的输出' },
    { id: 'femogen', label: 'FEMOGen', list: femogenEntries, clear: onClearFemogen, errors: femogenErrorCount,
      title: 'FEMOGen 页：femoGen 页面自身产生的日志（log / warn / error）',
      clearTitle: '清空 FEMOGen 页的前端日志' },
    { id: 'host', label: 'Host', list: hostEntries, clear: onClearHost, errors: hostErrorCount,
      title: 'Host 页：投影窗、会话等宿主侧功能打印的日志',
      clearTitle: '清空 Host 页的宿主日志' },
  ];
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const isCompiler = active.id === 'compiler';
  const isFemogen = active.id === 'femogen';
  const isHost = active.id === 'host';
  // 复制/清空一律作用于**当前这一页**的列表——跨页操作会让人误以为清掉了别处。
  const activeList = active.list;
  const clearActive = active.clear;
  const canClear = typeof clearActive === 'function';
  // 复制全部（2026-09-08 取代清空）：剧本页 [时间][级别] 来源: 全文；编译器页
  // 引擎 print 无级别概念，只 [时间] 原文；FEMOGen 页 [时间][console 方法] 文本。
  // 一条一行。非 https/localhost 场景 navigator.clipboard 可能缺席 → 回退 execCommand。
  const [copied, setCopied] = useState(false);
  const copyAll = useCallback(() => {
    if (activeList.length === 0) return;
    const text = activeList
      .map((e) =>
        isCompiler || isHost
          ? `[${fmtTime(e.ts)}] ${e.text}`
          : isFemogen
            ? `[${fmtTime(e.ts)}] [${e.level}] ${e.text}`
            : `[${fmtTime(e.ts)}] [${e.level}] ${e.kind}: ${e.text}`
      )
      .join('\n');
    const flash = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    };
    const fallbackCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand('copy')) flash();
      } catch { /* 极老内核无剪贴板通道，静默放弃 */ }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }, [activeList, isCompiler]);

  // 行样式（两页共用，2026-09-11 提出来避免两处各写一份漂移）：
  // 容器一次定死内边距/圆角/折行/字号——注意 fontSize+lineHeight 必须留在
  // 容器上，否则撑行高的是**继承来的** strut（1.6×继承字号≈24px），
  // 几个 10px 的 span 压不住（实测不写时单条行高 29.9px、写了 23.2px）。
  const rowSt = {
    padding: '3px 6px',
    marginBottom: 4,
    borderRadius: 'var(--femo-radius-sm)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: 10,
    lineHeight: 1.6,
  };
  const timeSt = {
    fontFamily: 'var(--femo-font-mono)',
    fontSize: 9.5,
    color: 'var(--femo-text-4-weak)',
    lineHeight: 1.6,
  };
  const monoText = {
    fontSize: 10,
    lineHeight: 1.6,
    fontFamily: 'var(--femo-font-mono)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  };
  // 编译器页正文：引擎 print 无级别，一律常规色、无底色。
  const compilerTextSt = { ...monoText, color: 'var(--femo-text-2)' };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        background: 'var(--femo-panel-bg)',
        borderRight: 'var(--femo-border-w) solid var(--femo-border-strong)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* 头部：标题 + 错误计数 + 编译 + 复制 + 清空 + 关闭 */}
      <div
        style={{
          padding: '10px 12px',
          borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 800,
            color: 'var(--femo-text-1)',
            letterSpacing: '0.02em',
          }}
        >
          调试
        </span>
        {/* 错误计数徽标 2026-09-11 挪到「剧本」页签上（跟内容同页更直观） */}
        <span style={{ flex: 1 }} />
        {/* 编译（2026-09-08）：零 token 编译干跑，日志直接流到本面板。
            蓝底主色——面板头部唯一的主操作，与右侧次级「复制」形成层级。 */}
        {typeof onCompile === 'function' && (
          <button
            onClick={onCompile}
            disabled={compiling}
            title={compiling ? '编译干跑进行中…' : '零 token 编译干跑：AI/人类节点由调试器替答，日志实时显示在下方'}
            style={{
              padding: '3px 10px',
              borderRadius: 'var(--femo-radius-md)',
              border: 'var(--femo-border-w) solid var(--femo-btn-primary)',
              background: 'var(--femo-btn-primary)',
              color: 'var(--femo-on-accent)',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'var(--femo-font-sans)',
              cursor: compiling ? 'wait' : 'pointer',
              opacity: compiling ? 0.6 : 1,
            }}
          >
            {compiling ? '编译中' : '编译'}
          </button>
        )}
        <button
          onClick={copyAll}
          disabled={activeList.length === 0}
          title={
            activeList.length === 0
              ? '当前页暂无可复制的日志'
              : isCompiler
                ? '复制当前页（编译器）全部输出'
                : '复制当前页（剧本）全部日志（时间 / 级别 / 来源 / 全文）'
          }
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--femo-radius-md)',
            border: 'var(--femo-border-w) solid var(--femo-border-strong)',
            background: 'var(--femo-bg)',
            color: copied ? 'var(--femo-success-strong)' : 'var(--femo-text-2)',
            fontSize: 10,
            fontWeight: 700,
            cursor: activeList.length === 0 ? 'default' : 'pointer',
            fontFamily: 'var(--femo-font-sans)',
            opacity: activeList.length === 0 ? 0.5 : 1,
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
        {/* 清空（2026-09-11 回归）：复制右侧、关闭左侧——同款中性描边，
            不抢蓝底「编译」的主操作地位；空日志时置灰。清的是当前页。 */}
        {canClear && (
          <button
            onClick={clearActive}
            disabled={activeList.length === 0}
            title={activeList.length === 0 ? '当前页暂无日志可清空' : active.clearTitle}
            style={{
              padding: '3px 8px',
              borderRadius: 'var(--femo-radius-md)',
              border: 'var(--femo-border-w) solid var(--femo-border-strong)',
              background: 'var(--femo-bg)',
              color: 'var(--femo-text-2)',
              fontSize: 10,
              fontWeight: 700,
              cursor: activeList.length === 0 ? 'default' : 'pointer',
              fontFamily: 'var(--femo-font-sans)',
              opacity: activeList.length === 0 ? 0.5 : 1,
            }}
          >
            清空
          </button>
        )}
        <button
          onClick={onClose}
          title="关闭调试窗口"
          style={{
            width: 22,
            height: 22,
            borderRadius: 'var(--femo-radius-md)',
            border: 'var(--femo-border-w) solid var(--femo-border-strong)',
            background: 'var(--femo-bg)',
            color: 'var(--femo-text-2)',
            fontSize: 11,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>

      {/* 页签条（2026-09-11 用户点名）：『剧本』= 原有运行信息；『编译器』= 后端
          编译器的 print 原文；『FEMOGen』= 前端 femoGen 自己的 console 输出；
          『Host』= 宿主（投影窗这边）本插件代码的 console 输出。各自带条数：
          有错时按原头部徽标口径显示「N 错」（红），无错显示总条数（灰）——
          不同时显示两个数字，免得看成人两条目。
          窄屏（手机 320px）四个 chip 会顶到边，故整条可横向滚动而不换行。 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 10px',
          borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
          flexShrink: 0,
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.title}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 9px',
                borderRadius: 'var(--femo-radius-md)',
                border: `var(--femo-border-w) solid ${on ? 'var(--femo-border-strong)' : 'transparent'}`,
                background: on ? 'var(--femo-bg)' : 'transparent',
                color: on ? 'var(--femo-text-1)' : 'var(--femo-text-3)',
                fontSize: 10.5,
                fontWeight: on ? 800 : 600,
                fontFamily: 'var(--femo-font-sans)',
                cursor: 'pointer',
              }}
            >
              {t.label}
              {t.errors > 0 ? (
                <span title={`${t.errors} 条错误`} style={{ fontSize: 9, fontWeight: 800, color: 'var(--femo-danger)' }}>
                  {t.errors} 错
                </span>
              ) : t.list.length > 0 ? (
                <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--femo-text-4-weak)' }}>{t.list.length}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 日志流：新条目在最前，旧的被刷下去（两页共用同一套行样式） */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          padding: '8px 10px',
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      >
        {isCompiler ? (
          compilerEntries.length === 0 ? (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--femo-text-4-weak)',
                lineHeight: 1.8,
                padding: '8px 2px',
              }}
            >
              暂无编译器输出。
              <br />
              这里显示引擎（编译器/运行时）打印的原始日志：
              <br />
              运行或干跑剧本时，标准输出和错误信息（带 [stderr] 前缀）都会实时出现在这里。
            </div>
          ) : (
            compilerEntries.map((e) => (
              <div key={e.id} style={rowSt}>
                <span style={timeSt}>{fmtTime(e.ts)}</span>
                <span style={compilerTextSt}> {e.text}</span>
              </div>
            ))
          )
        ) : isFemogen ? (
          femogenEntries.length === 0 ? (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--femo-text-4-weak)',
                lineHeight: 1.8,
                padding: '8px 2px',
              }}
            >
              暂无前端日志。
              <br />
              这里显示 femoGen 页面自身产生的日志（log / warn / error），
              <br />
              页面运行中随时产生、随时出现在这里。
            </div>
          ) : (
            femogenEntries.map((e) => {
              // 级别配色与『剧本』页同源（同 LEVEL_STYLE）：warn 黄底 / error
              // 红底 / log·info 无底色。console 方法名当"来源"栏位显示。
              const st = LEVEL_STYLE[e.level] || LEVEL_STYLE.info;
              const kindSt = { ...timeSt, fontWeight: 700, color: st.dot };
              return (
                <div key={e.id} style={{ ...rowSt, background: st.rowBg }}>
                  <span style={timeSt}>{fmtTime(e.ts)}</span>
                  <span style={kindSt}> [{e.level}]</span>
                  <span style={compilerTextSt}> {e.text}</span>
                </div>
              );
            })
          )
        ) : isHost ? (
          hostEntries.length === 0 ? (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--femo-text-4-weak)',
                lineHeight: 1.8,
                padding: '8px 2px',
              }}
            >
              暂无宿主日志。
              <br />
              这里显示投影窗、会话等宿主侧功能打印的日志。
              <br />
              引擎打印的日志不在这页，请看「编译器」页。
            </div>
          ) : (
            hostEntries.map((e) => {
              // 行首 [warn]/[error] 标记由宿主 src/host-log.ts 加：同款级别配色，
              // 标记收进"来源"栏，正文不留前缀。
              const m = HOST_LEVEL_RE.exec(e.text || '');
              const lv = m ? m[1] : 'log';
              const body = m ? e.text.slice(m[0].length) : e.text;
              const st = LEVEL_STYLE[lv] || LEVEL_STYLE.info;
              const kindSt = { ...timeSt, fontWeight: 700, color: st.dot };
              return (
                <div key={e.id} style={{ ...rowSt, background: st.rowBg }}>
                  <span style={timeSt}>{fmtTime(e.ts)}</span>
                  <span style={kindSt}> [{lv}]</span>
                  <span style={compilerTextSt}> {body}</span>
                </div>
              );
            })
          )
        ) : entries.length === 0 ? (
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--femo-text-4-weak)',
              lineHeight: 1.8,
              padding: '8px 2px',
            }}
          >
            暂无运行记录。
            <br />
            点上方「编译」可零 token 干跑剧本（AI/人类由调试器替答）；
            <br />
            正式运行后，后端的实时事件与报错也会出现在这里。
            <br />
            剧本 / 编译器 / FEMOGen / Host 四个标签页各有独立的日志，
            <br />
            复制和清空按钮只作用于当前所在的标签页。
          </div>
        ) : (
          entries.map((e) => {
            const st = LEVEL_STYLE[e.level] || LEVEL_STYLE.info;
            const text = e.text || '';
            // 单行内联排版（2026-09-11 用户点名，改回 09-08 r3 的两行制）：
            // 「时间 [来源] 正文」同一条内联流，正文紧接来源之后；整条过长时
            // 自然折行，续行从行首（时间那一列）顶格起——不是"从第三栏才开始
            // 换、再跟第三栏对齐"的表格式排布。理由：两条一屏变一条一屏，
            // 省将近一半竖向空间。断行 overflowWrap:anywhere（只在放不下时断）。
            const kindSt = { ...timeSt, fontWeight: 700, color: st.dot };
            const textStyle = {
              ...monoText,
              color: e.level === 'error' ? 'var(--femo-text-1)' : 'var(--femo-text-2)',
            };
            return (
              // 行底色（2026-09-11）：warn 黄 / error 红（见 LEVEL_STYLE.rowBg）；
              // info 无底色。内边距统一给到所有行，保证时间/正文左缘齐平。
              <div key={e.id} style={{ ...rowSt, background: st.rowBg }}>
                <span style={timeSt}>{fmtTime(e.ts)}</span>
                <span style={kindSt}> [{e.kind}]</span>
                {text ? <span style={textStyle}> {text}</span> : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export { DebugPanel };
