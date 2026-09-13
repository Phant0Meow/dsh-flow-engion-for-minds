// ════════════════════════════════════════
// ═══════.  femoPreview.jsx       ═════════
// ════════════════════════════════════════


import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// 头排统一芯片配方（2026-09-07）：复制/图到文本/文本到图/恢复四键同构——
// 浅色同系底 + 1px 同色细边 + 同字号字重，仅用颜色区分语义。可点击态用
// 主题强调色（灰底像禁用，用户反馈）；文本到图有未应用修改时用更强填充。
// 色值全走主题 CSS var，深浅主题自适应。
const PRIMARY = 'var(--femo-primary)';
const chip = (color, active = false) => ({
  padding: '3px 10px',
  borderRadius: 'var(--femo-radius-md)',
  background: `color-mix(in srgb, ${color} ${active ? 16 : 10}%, transparent)`,
  border: `1px solid color-mix(in srgb, ${color} ${active ? 45 : 35}%, transparent)`,
  color,
  cursor: 'pointer',
  fontSize: 10,
  fontWeight: 700,
  fontFamily: 'var(--femo-font-sans)',
  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
});

function FemoPreview({ value, onChange, error, warnings = [], dirty, onApply, onRestore, onGraphToFemo }) {
  const lineNumbersRef = useRef(null);
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const [lineCount, setLineCount] = useState(1);
  // 复制回执：按钮短暂变「✓ 已复制」（成功绿），1.6s 自动还原。
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  // 图↔文同步回执（2026-09-07）：与复制同款设计语言。flash 窗口期内按钮
  // 文案/配色按 error prop 实时推导——onApply 同步 setFemoError，与
  // setFlash 同一批次提交，render 时 error 已是新值，无需额外状态。
  const [g2tFlash, setG2tFlash] = useState(false);
  const g2tTimerRef = useRef(null);
  const [applyFlash, setApplyFlash] = useState(false);
  const applyTimerRef = useRef(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    if (g2tTimerRef.current) clearTimeout(g2tTimerRef.current);
    if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
  }, []);

  const flash = (setter, timerRef, ms = 1600) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setter(true);
    timerRef.current = setTimeout(() => setter(false), ms);
  };

  const handleCopy = useCallback(async () => {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value || '');
        ok = true;
      } else {
        // 非安全上下文（如 http://tailscale-ip 手机访问）剪贴板 API 不可用
        // → 隐藏 textarea + execCommand 降级。
        const ta = document.createElement('textarea');
        ta.value = value || '';
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopied(ok);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
  }, [value]);

  // 从错误信息提取行号：优先取统一报错链路的结构化诊断（精确），
  // 否则退回正则匹配「第 N 行:」前缀（formatDiagnostic 保证该前缀存在）。
  const errorLine = useMemo(() => {
    if (!error) return null;
    const diag = (Array.isArray(error?.diagnostics) ? error.diagnostics : [])
      .find((d) => d?.severity === 'error' && d.line != null);
    if (diag) return diag.line;
    const match = error.match(/第\s*(\d+)\s*行/);
    return match ? parseInt(match[1], 10) : null;
  }, [error]);

  useEffect(() => {
    setLineCount(value.split('\n').length);
  }, [value]);

  const handleScroll = useCallback(() => {
    if (lineNumbersRef.current && textareaRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
    // 同步高亮条的位置
    if (highlightRef.current && textareaRef.current && errorLine != null) {
      const scrollTop = textareaRef.current.scrollTop;
      const lineHeight = 18.9; // 10.5px * 1.8
      highlightRef.current.style.top =
        11 + (errorLine - 1) * lineHeight - scrollTop + 'px';
    }
  }, [errorLine]);

  // 当错误行号或内容变化时，更新高亮条位置（基于当前滚动位置）
  useEffect(() => {
    if (textareaRef.current && highlightRef.current && errorLine != null) {
      const scrollTop = textareaRef.current.scrollTop;
      const lineHeight = 18.9;
      highlightRef.current.style.top =
        11 + (errorLine - 1) * lineHeight - scrollTop + 'px';
    }
  }, [errorLine, value]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: '14px 14px 14px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 9,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 800,
            color: 'var(--femo-neutral)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          FEMO 预览
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {error && (
            <button onClick={onRestore} style={chip('var(--femo-warning)', true)}>
              恢复
            </button>
          )}
          <button
            onClick={handleCopy}
            title="复制全文到剪贴板"
            style={chip(copied ? 'var(--femo-success)' : PRIMARY, copied)}
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
          <button
            onClick={() => { onGraphToFemo?.(); flash(setG2tFlash, g2tTimerRef); }}
            style={chip(g2tFlash ? 'var(--femo-success)' : PRIMARY, g2tFlash)}
          >
            {g2tFlash ? '✓ 已生成' : '图到文本'}
          </button>
          <button
            onClick={() => { onApply?.(); flash(setApplyFlash, applyTimerRef); }}
            style={chip(
              applyFlash
                ? (error ? 'var(--femo-danger)' : 'var(--femo-success)')
                : PRIMARY,
              applyFlash || dirty,
            )}
          >
            {applyFlash ? (error ? '✕ 失败' : '✓ 已应用') : '文本到图'}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 8,
            padding: '6px 9px',
            background: 'var(--femo-danger-soft)',
            border: 'var(--femo-border-w) solid var(--femo-danger-border)',
            borderRadius: 'var(--femo-radius-sm)',
            fontSize: 10,
            color: 'var(--femo-danger)',
            lineHeight: 1.5,
            maxHeight: 60,
            overflow: 'auto',
          }}
        >
          {error}
        </div>
      )}

      {/* 非阻断警告（统一报错链路 warning 级）：可运行，仅提醒 */}
      {Array.isArray(warnings) && warnings.length > 0 && (
        <div
          style={{
            marginBottom: 8,
            padding: '6px 9px',
            background: 'var(--femo-warning-soft)',
            border: 'var(--femo-border-w) solid var(--femo-warning-border)',
            borderRadius: 'var(--femo-radius-sm)',
            fontSize: 10,
            color: 'var(--femo-warning-strong)',
            lineHeight: 1.5,
            maxHeight: 60,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {warnings.map((w, i) => {
            const loc = w?.line != null ? `第 ${w.line} 行: ` : '';
            return <div key={i}>⚠ {loc}{w?.message || ''}</div>;
          })}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, borderRadius: 'var(--femo-radius-lg)', overflow: 'hidden' }}>
        <div
          ref={lineNumbersRef}
          style={{
            // 行号区整体缩为原 75%（30 → 22.5），左侧空间同步收紧
            width: 22.5,
            background: 'var(--femo-preview-bg-2)',
            color: 'var(--femo-mobile-text-3)',
            fontFamily: 'var(--femo-font-mono)',
            fontSize: 10.5,
            lineHeight: 1.8,
            padding: '11px 3px 11px 6px',
            textAlign: 'right',
            userSelect: 'none',
            overflow: 'hidden',
            whiteSpace: 'pre',
            borderRight: 'var(--femo-border-w) solid var(--femo-preview-border)',
          }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1}>{i + 1}</div>
          ))}
        </div>

        {/* 带高亮覆盖层的文本区 */}
        <div style={{ position: 'relative', flex: 1 }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            onScroll={handleScroll}
            spellCheck={false}
            style={{
              width: '100%',
              height: '100%',
              background: 'var(--femo-mobile-bg-2)',
              // 左 padding 归零：顶格代码紧贴行号区边缘
              padding: '11px 0',
              overflow: 'auto',
              resize: 'none',
              fontFamily: 'var(--femo-font-mono)',
              fontSize: 10.5,
              lineHeight: 1.8,
              color: 'var(--femo-mobile-text-2-alt)',
              border: 'none',
              outline: 'none',
              whiteSpace: 'pre',
              display: 'block', // 确保覆盖层可以正确定位
            }}
          />
          {errorLine != null && (
            <div
              ref={highlightRef}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: 18.9,
                background: 'var(--femo-danger-soft-2)',
                borderLeft: 'var(--femo-border-w-accent) solid var(--femo-danger)',
                pointerEvents: 'none',
                zIndex: 1,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export { FemoPreview };
