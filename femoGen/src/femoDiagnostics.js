// ═══════════════════════════════════════════════════════════════
// ═══ femoDiagnostics.js — femoParser 统一报错链路 ═══
// ═══════════════════════════════════════════════════════════════
// 设计（2026-09-07 报错链路解耦）：
//   语法检查的各处代码遇到问题不再各自 `throw new Error(手工拼字符串)`，
//   而是统一调用本模块的 reporter。每条诊断（diagnostic）固定携带：
//     severity : 'error' | 'warning'
//       error   = 不能运行，阻断（parseFEMO 抛 FEMOSyntaxError，运行门禁拦截）
//       warning = 可以运行，仅提醒（挂 result.warnings，UI 黄条展示）
//     line     : 1-based 行号（未知为 null）
//     lineText : 出错的那一行原文（展示用，超长截断）
//     message  : 报错信息本体（不含行号前缀——拼装统一交给 formatDiagnostic）
//     where    : 所属区域（如 'mainflow' / 'module xxx' / '顶层'），可为空
//   与 Python 编译器 FEMO_errors 的 WARNING 桶、script.warnings {'where','message'}
//   同语义对齐：diagnostic 是后者的超集，两键原样保留。

export const SEVERITY_ERROR = 'error';
export const SEVERITY_WARNING = 'warning';

// 行原文展示上限：超出截断加省略号（报错条高度有限，长 prompt 行不该撑爆 UI）
const LINE_TEXT_MAX = 120;

export function clipLineText(text) {
  const s = String(text ?? '').replace(/\t/g, '    ').trim();
  if (s.length <= LINE_TEXT_MAX) return s;
  return s.slice(0, LINE_TEXT_MAX) + '…';
}

export function makeDiagnostic(severity, { line = null, lineText = '', message, where = '' } = {}) {
  return {
    severity,
    line: Number.isFinite(line) ? line : null,
    lineText: clipLineText(lineText),
    message: String(message || ''),
    where: String(where || ''),
  };
}

// 统一拼装：`第 N 行: "出错行" — 信息`。无行号时退化为 `where: 信息` / `信息`。
// 「第 N 行:」前缀是 UI 高亮条的锚（FemoPreview 正则 /第\s*(\d+)\s*行/ 的兼容兜底）。
export function formatDiagnostic(d) {
  const where = d.where ? `${d.where} → ` : '';
  if (d.line != null) {
    const lineText = d.lineText ? ` "${d.lineText}"` : '';
    return `第 ${d.line} 行:${lineText} ${where}${d.message}`;
  }
  return `${where}${d.message}`;
}

// 统一抛出的语法错误：message 是全部诊断的人读文本，
// .diagnostics 保留结构化数据供 UI 精确高亮/分色展示。
export class FEMOSyntaxError extends Error {
  constructor(diagnostics, header = '') {
    // 多条诊断时逐条编号（聚合计数报错场景，与原 validateActionSyntax 风格一致）
    const body = diagnostics
      .map((d, i) =>
        diagnostics.length > 1 ? `  ${i + 1}. ${formatDiagnostic(d)}` : formatDiagnostic(d)
      )
      .join('\n');
    super(header ? `${header}\n${body}` : body);
    this.name = 'FEMOSyntaxError';
    this.diagnostics = diagnostics;
  }
}

// 从捕获的异常里取 warning 诊断（无则空数组）——UI 展示「可运行，仅提醒」用
export function warningsFromThrowable(e) {
  const diags = e && e.diagnostics;
  if (!Array.isArray(diags)) return [];
  return diags.filter((d) => d && d.severity === SEVERITY_WARNING);
}

// ═══ 报错链路唯一入口 ═══
// parser 内所有检查点的调用方式：
//   rep.fail(信息, { line, lineText, where })  → 记 error 并立即中断（解析期：
//                                                出错当下已无法继续解析）
//   rep.error(信息, { ... })                   → 只记 error（校验期：收集全部，
//                                                最后 rep.throwIfErrors() 一次性抛）
//   rep.warning(信息, { ... })                 → 记 warning（永不阻断）
export function createReporter() {
  const items = [];

  const push = (severity, message, opts) => {
    const d = makeDiagnostic(severity, { ...(opts || {}), message });
    items.push(d);
    return d;
  };

  return {
    items,
    get warnings() {
      return items.filter((d) => d.severity === SEVERITY_WARNING);
    },
    get errors() {
      return items.filter((d) => d.severity === SEVERITY_ERROR);
    },
    hasErrors() {
      return items.some((d) => d.severity === SEVERITY_ERROR);
    },
    warning(message, opts) {
      return push(SEVERITY_WARNING, message, opts);
    },
    // 记录 error 但不抛（配合 throwIfErrors 做聚合计数报错）
    error(message, opts) {
      return push(SEVERITY_ERROR, message, opts);
    },
    // 记录 error 并立即中断解析（替代原 throw new Error）
    fail(message, opts) {
      push(SEVERITY_ERROR, message, opts);
      throw new FEMOSyntaxError([items[items.length - 1]]);
    },
    // 有 error 则聚合抛出（多条时 header 带计数；header 缺省给通用文案）
    throwIfErrors(header = '') {
      const errs = items.filter((d) => d.severity === SEVERITY_ERROR);
      if (errs.length === 0) return;
      const head = header
        ? (errs.length > 1 ? `${header}（共 ${errs.length} 处）：` : `${header}：`)
        : (errs.length > 1 ? `剧本语法检查未通过（共 ${errs.length} 处）：` : '');
      throw new FEMOSyntaxError(errs, head);
    },
  };
}
