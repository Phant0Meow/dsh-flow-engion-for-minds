// ═══════════════════════════════════════════════════════════════
// ═══ femoLog.js — FEMOGen 前端日志总线（调试面板「FEMOGen」页的数据面）═══
// ═══════════════════════════════════════════════════════════════
// 2026-09-11 用户点名："把前端 FEMOGen 的 log 信息输出到这里…代码里面写的有
// log 的地方，就直接 print 到这里"。
//
// 做法：**不改 157 处调用点**，而是钩住 console —— 代码里原来 console.log/
// warn/error 打在哪儿，这里就收哪儿（femotGen 里所有日志调用就此全部上屏）。
// 原 console 行为完整保留（转发给原函数），所以浏览器 DevTools 里照旧能看到，
// 这个模块只是"多一路落点"，不替代任何东西（同 diag-feed 的观测哲学）。
//
// 已知边界（写在这里免得日后误会）：
//  - console 是全局的。插件模式下 femoGen 与 dsh 外壳同窗口，所以**宿主外壳/
//    其它插件的 console 输出也会被收进来**。这是"不改调用点"的必然代价，
//    也符合调试面"多给比少给强"的口径；要精确区分只能靠栈回溯，而打包后
//    栈里是 lib/client.js:行号，不可靠，故不做。
//  - 通知走**微任务批量 flush**：若在 React 渲染期同步 setState，可能触发
//    "Cannot update a component while rendering" 警告 → 该警告又走 console.error
//    → 再进本模块 → 死循环。批量延后一拍即根治，且高频日志只触发一次渲染。

const CAP = 400;          // 环形缓冲条数（内存态，刷新即重来——观测面不是档案）
const TEXT_MAX = 500;     // 单条截断：一条超长对象不该撑爆面板

const ring = [];
const listeners = new Set();
let seq = 0;
let installed = false;
let pending = [];
let flushScheduled = false;

/** 参数 → 单行文本（对象尽量 JSON 化；Error 带首帧位置；循环引用兜底 String）。 */
function fmtArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) {
    const at = (a.stack || '').split('\n')[1];
    return at ? `${a.message} @ ${at.trim()}` : a.message;
  }
  if (typeof a === 'undefined') return 'undefined';
  if (a === null) return 'null';
  try {
    const s = JSON.stringify(a);
    return s === undefined ? String(a) : s;
  } catch {
    return String(a);
  }
}

/** 入账一条（level: 'log' | 'info' | 'warn' | 'error'），并安排批量通知。 */
export function pushFemoLog(level, args) {
  const entry = {
    id: ++seq,
    ts: Date.now(),
    level,
    text: args.map(fmtArg).join(' ').slice(0, TEXT_MAX),
  };
  ring.push(entry);
  if (ring.length > CAP) ring.shift();
  pending.push(entry);
  if (!flushScheduled) {
    flushScheduled = true;
    // 微任务批量 flush：一次事件循环内来的多条合成一批，避免逐条 setState。
    queueMicrotask(() => {
      flushScheduled = false;
      const batch = pending;
      pending = [];
      for (const fn of listeners) {
        try { fn(batch); } catch { /* 单个订阅者异常不影响其余 */ }
      }
    });
  }
  return entry;
}

/** 订阅实时批次（batch 为时间正序的条目数组）。返回退订函数。 */
export function subscribeFemoLog(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 已有历史（时间正序，最多 n 条）——面板挂载时补首屏用。 */
export function femoLogTail(n = CAP) {
  const count = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), CAP) : CAP;
  return ring.slice(-count);
}

/** 清空缓冲（调试面板「清空」按钮用；只清本模块的环，不动 DevTools）。 */
export function clearFemoLog() {
  ring.length = 0;
}

/**
 * 装钩子（幂等）。在 FemoWorAuto 模块加载时调用一次即可——femoGen 两种模式
 * （插件内嵌 / 独立 vite）都会走到那里，等于"页面一加载就开始收"。
 */
export function installFemoLogCapture() {
  if (installed) return;
  installed = true;
  const LEVELS = { log: 'log', info: 'info', warn: 'warn', error: 'error' };
  for (const name of Object.keys(LEVELS)) {
    const orig = console[name];
    if (typeof orig !== 'function') continue;
    console[name] = (...args) => {
      try { pushFemoLog(LEVELS[name], args); } catch { /* 采集失败绝不反噬业务 */ }
      orig.apply(console, args);   // 原行为原样保留
    };
  }
}
