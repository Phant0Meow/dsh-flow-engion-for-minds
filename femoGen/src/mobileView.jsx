// ═══════════════════════════════════════════════════════════════
// ═══ mobileView.jsx  ───  手机端统一视图管理
// ═══════════════════════════════════════════════════════════════
//
// 布局（固定，不可整体滚动/缩放）：
//   ┌─────────────────────────────────┐
//   │ TitleBar  (5vh)                 │
//   ├─────────────────────────────────┤
//   │                                 │
//   │  Canvas  (75vh)                 │
//   │                                 │
//   ├─────────────────────────────────┤
//   │  BottomPanel  (20vh)            │
//   │  [Library | Project | Props]    │
//   └─────────────────────────────────┘
//
// 手势：
//   单指拖动  →  平移画布
//   双指捏合  →  缩放画布
//   单击      →  选中节点/边
//   双击      →  打开节点编辑
//   长按      →  调出节点上下文菜单（预留）
//
// ═══════════════════════════════════════════════════════════════

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import { ti, inp, btnP, btnS, getNodeSize, applyForLinkage } from './common';
import { LibPanel } from './libPanel';
import { ProjPanel, useModelList, sourceOptions } from './projectPanel';
import { BubbleOverlay } from './bubbleOverlay';
import { FemoPreview } from './femoPreview';
import { DebugPanel } from './debugPanel';
import { FaPlay, FaStop, FaForward, FaPalette, FaUserPlus, FaTerminal, FaFolderOpen, FaFloppyDisk, IconPanelLeftOutline, FaSquareOutline } from './faIcons';

// ─────────────────────────────────────────────
// 颜色 / 主题 token
// ─────────────────────────────────────────────
const T = {
  bg: 'var(--femo-mobile-bg)',
  surface: 'var(--femo-mobile-surface)',
  surfaceHover: 'var(--femo-mobile-surface-hover)',
  border: 'var(--femo-mobile-border)',
  borderLight: 'var(--femo-mobile-border-light)',
  accent: 'var(--femo-primary)',
  accentGlow: 'var(--femo-primary-glow)',
  textPrimary: 'var(--femo-mobile-text-1)',
  textSecondary: 'var(--femo-text-3)',
  textMuted: 'var(--femo-mobile-text-3)',
  tabActive: 'var(--femo-primary)',
  tabInactive: 'var(--femo-mobile-border)',
  danger: 'var(--femo-danger)',
  success: 'var(--femo-success)',
  warning: 'var(--femo-warning)',
};

// ─────────────────────────────────────────────
// 全局样式注入（仅手机端追加）
// ─────────────────────────────────────────────
const MobileGlobalStyle = () => (
  <style>{`
    /* round44：全局 touch-action:none 是仓库卡片无法滚动的元凶——
       Chrome 从触点向上累积 touch-action，body 的 none 污染整条链。
       画布区自有独立规则（.femo-canvas-zone），此处不再全局禁触。 */
    html, body {
      overscroll-behavior: none;
    }
    /* round50：防拖拽误选只作用于 femo 自己的容器，不再挂 html/body——
       user-select 沿树继承，全局 none 会把 dsh 聊天正文的选择一起杀掉
       （2026-08-28 猫猫报 3081 手机端无法选中 AI/用户消息文字的根因）。
       画布区拖节点/连线的手势保护保留在自身容器上。 */
    .femo-canvas-zone,
    .femo-bottom-scroll {
      user-select: none;
      -webkit-user-select: none;
    }
    /* 画布区禁止浏览器默认触摸行为（拖节点/连线/平移全走自定义手势）。
       round55：-webkit-touch-callout 掐掉 iOS 长按呼出的放大镜/菜单。
       Android 长按选字由 useMobileCanvasGesture 里的 non-passive
       preventDefault 在手势层根治——React 17+ 的合成 touchstart/touchmove
       一律 passive 挂载，组件里 e.preventDefault() 是无效调用；
       CSS user-select:none（round50）只能定义"谁不可选"，拦不住
       浏览器原生长按选择流程本身，只有取消 touchstart 默认行为这一条路。 */
    .femo-canvas-zone {
      touch-action: none;
      -webkit-touch-callout: none;
    }
    /* 底部面板允许垂直滚动 */
    .femo-bottom-scroll {
      touch-action: pan-y;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* 输入框恢复 touch */
    .femo-bottom-scroll input,
    .femo-bottom-scroll textarea,
    .femo-bottom-scroll select {
      touch-action: auto;
      user-select: text;
      -webkit-user-select: text;
    }
    /* 侧边菜单遮罩淡入 */
    @keyframes fadeInOverlay {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* 侧边菜单滑入 */
    @keyframes slideInMenu {
      from { transform: translateX(-100%); }
      to   { transform: translateX(0); }
    }
    /* FEMO 面板滑入 */
    @keyframes slideInFemo {
      from { transform: translateX(100%); }
      to   { transform: translateX(0); }
    }
    /* 底部面板切换淡入 */
    @keyframes fadePanel {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    /* 气泡弹出 */
    @keyframes popIn {
      from { opacity: 0; transform: translate(-50%, -46%) scale(0.92); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    /* 标题栏闪光扫描 */
    @keyframes scanLine {
      0%   { left: -60%; }
      100% { left: 110%; }
    }
    /* 状态指示灯脉冲 */
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.6; transform: scale(0.85); }
    }
    /* round27：仓库拖拽 ghost 弹出（弹性放大+淡入，只动 opacity/transform） */
    @keyframes ghostPopIn {
      from { opacity: 0; transform: scale(0.7); }
      to   { opacity: 1; transform: scale(1.05); }
    }
    /* round27：ghost 光晕呼吸（只动 box-shadow，与 popIn 属性不相交可同列） */
    @keyframes ghostBreath {
      from { box-shadow: 0 4px 16px var(--femo-primary-glow); }
      to   { box-shadow: 0 6px 26px var(--femo-primary-glow-x); }
    }
    /* round27：画布"可放置"提示浮现 */
    @keyframes dropHintIn {
      from { opacity: 0; transform: scale(0.985); }
      to   { opacity: 1; transform: scale(1); }
    }
    /* 流式光标 */
    .mob-cursor { animation: blink 0.75s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    /* 运行控制图标按钮（2026-09-06 统一重造）：手机无 hover，反馈走按压
       回缩 + 提亮；顺手掐掉移动端点按灰闪（tap-highlight）。 */
    .femo-mob-icon-btn {
      transition: transform 0.12s ease, filter 0.12s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .femo-mob-icon-btn:active {
      transform: scale(0.88);
      filter: brightness(1.3);
    }
    /* 设置面板三键（2026-09-08）：同款按压反馈语言（回缩+提亮），宽幅文字按钮
       幅度比 32px 图标芯片温和；同样掐移动端点按灰闪。 */
    .femo-mob-setting-btn {
      transition: transform 0.12s ease, filter 0.12s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .femo-mob-setting-btn:active {
      transform: scale(0.97);
      filter: brightness(1.15);
    }
  `}</style>
);

// ─────────────────────────────────────────────
// TitleBar
// ─────────────────────────────────────────────
function MobileTitleBar({
  projName,
  flowStatus,
  femoVisible,
  onBack,
  onExpand,
  onToggleFemo,
  onRun,
  onStop,
  onResume,
  hasActiveRunningNodes,
  // 文件读写（2026-09-11 手机端补齐）：与桌面工具栏「导入 .femo / 导出 .femo」
  // 同源回调（插件=host 系统对话框 / 独立=浏览器 file input + 下载）。
  onImport,
  onExport,
  exportBusy,
  // Module 子画布层级（2026-09-06）：非主流程时显示「‹ 模块名」返回键。
  locationPath,
  onNavigatePath,
}) {
  const statusDot = {
    idle:    { c: T.textMuted,  label: '' },
    running: { c: T.success,    label: '运行中' },
    paused:  { c: T.warning,    label: '已挂起，可续跑' },
  }[flowStatus] || { c: T.textMuted, label: '' };

  return (
    <div
      style={{
        position: 'relative',
        height: '5vh',
        minHeight: 40,
        maxHeight: 56,
        background: T.surface,
        borderBottom: `var(--femo-border-w) solid ${T.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        flexShrink: 0,
        zIndex: 100,
        overflow: 'hidden',
      }}
    >
      {/* 扫光效果 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          width: '60%',
          height: '100%',
          background:
            'linear-gradient(90deg,transparent,var(--femo-primary-glow-weak),transparent)',
          pointerEvents: 'none',
          animation: 'scanLine 4s linear infinite',
        }}
      />

      {/* 左侧：插件模式开边栏（全屏态，退出沉浸并开 dsh 边栏）/ 最大化（容器态，
          回沉浸）。2026-09-11 用户点名两次改这套图标：①←/→ 箭头→FA 窗口控件
          （箭头暗示左右移动，与「窗口状态切换」的真实语义无关）；②FA 的
          fa-maximize 是四角括号各带一支对角箭头，看着像「移动窗口」，遂定案——
          左=宿主同款边栏图标 IconPanelLeftOutline，右=FA regular 描边方块
          FaSquareOutline（solid 方块是隔壁「停止」键的图形，故取描边）。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {onExpand ? (
          <button
            onClick={onExpand}
            aria-label="全屏沉浸"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px 10px 6px 2px',
              display: 'flex',
              alignItems: 'center',
              color: T.textSecondary,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            <FaSquareOutline size={19} />
          </button>
        ) : onBack ? (
          <button
            onClick={onBack}
            aria-label="退出全屏，打开 dsh 边栏"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px 10px 6px 2px',
              display: 'flex',
              alignItems: 'center',
              color: T.textSecondary,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            <IconPanelLeftOutline size={19} />
          </button>
        ) : null}
      </div>

      {/* 中间：完整路径面包屑（2026-09-07 对齐桌面端语义）——文件名=主流程
          入口（点击回主画布），每级模块名=定位到该模块子画布（点击跳到那一
          层）。文件名与模块名是同一条 path 的段，UI 同款芯片（用户反馈）；
          主流程层级下文件名显示为普通大字标题（无可去之处）。当前层为末段。 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          overflow: 'hidden',
          padding: '0 8px',
        }}
      >
        {(() => {
          const inModule = locationPath !== undefined && locationPath.length > 1;
          const crumbChip = (isCurrent) => ({
            background: `color-mix(in srgb, ${T.textSecondary} ${isCurrent ? 14 : 8}%, transparent)`,
            border: `var(--femo-border-w) solid color-mix(in srgb, ${T.textSecondary} ${isCurrent ? 40 : 28}%, transparent)`,
            borderRadius: 'var(--femo-radius-sm)',
            height: 24,
            padding: '0 8px',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            color: T.textSecondary,
            lineHeight: 1,
            fontSize: 10.5,
            fontWeight: 800,
            fontFamily: 'var(--femo-font-sans)',
            maxWidth: 108,
            overflow: 'hidden',
            flexShrink: 0,
          });
          const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
          return (
            <>
              {inModule && onNavigatePath ? (
                <button
                  onClick={() => onNavigatePath(['mainflow'])}
                  title="回到主画布"
                  style={crumbChip(false)}
                >
                  <span style={ellipsis}>{projName || 'FEMO Flow'}</span>
                </button>
              ) : (
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color: T.textPrimary,
                    fontFamily: 'var(--femo-font-sans)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    letterSpacing: '0.01em',
                    flexShrink: 0,
                  }}
                >
                  {projName || 'FEMO Flow'}
                </span>
              )}
              {inModule && onNavigatePath && locationPath.slice(1).map((seg, idx) => {
                const depth = idx + 1; // locationPath 内的层级（0=mainflow）
                const isCurrent = depth === locationPath.length - 1;
                return (
                  <React.Fragment key={depth}>
                    <span style={{ color: T.textMuted, fontSize: 12, flexShrink: 0 }}>›</span>
                    <button
                      onClick={() => onNavigatePath(locationPath.slice(0, depth + 1))}
                      title={isCurrent ? `当前所在模块 ${seg}` : `定位到模块 ${seg}`}
                      style={crumbChip(isCurrent)}
                    >
                      <span style={ellipsis}>{seg}</span>
                    </button>
                  </React.Fragment>
                );
              })}
            </>
          );
        })()}
        {flowStatus !== 'idle' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 'var(--femo-radius-pill)',
                background: statusDot.c,
                display: 'block',
                animation: flowStatus === 'running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 10, color: statusDot.c, fontWeight: 700, fontFamily: 'var(--femo-font-mono)' }}>
              {statusDot.label}
            </span>
          </div>
        )}
      </div>

      {/* 右侧：运行控制 + 文件读写 + FEMO 切换
          （2026-09-11 用户点名调序：播放/停止/继续这组放最左，文件读写（导入/导出）
          在其右，FEMO 视图开关仍居最右——控制键与视图开关夹住文件读写。） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {/* 运行控制（2026-09-11 定型：**按钮恒定，只变展示**）——三枚芯片各自钉死
            一个动作/一套样式/一句 title，从生到死不变；运行阶段只决定渲染哪几枚：
              绿▶「运行」   = fresh start（onRun：reset 从头开演）——未开跑与挂起态都出现
              红⏹「停止」   = stop（onStop）——只在跑的时候出现
              琥珀⏩「继续」= resume（onResume：从断点续跑）——只在 stop 之后的挂起态出现
            挂起态顺序=常驻的运行键在前、挂起专属的继续键在后。暂停按钮删除
            （引擎无暂停语义——stop=suspended 可续跑）。同款 FA 图标芯片底
            （色 13% 底 + 38% 边），只靠语义色区分。 */}
        {(flowStatus === 'idle' || flowStatus === 'paused') && (
          <MobileIconBtn
            onClick={onRun}
            icon={FaPlay}
            color={T.success}
            title="运行（从头开演）"
          />
        )}
        {flowStatus === 'running' && (
          <MobileIconBtn
            onClick={onStop}
            icon={FaStop}
            color={T.danger}
            title="停止（可续跑）"
          />
        )}
        {flowStatus === 'paused' && (
          <MobileIconBtn
            onClick={onResume}
            icon={FaForward}
            color={T.warning}
            title="继续（从断点续跑）"
          />
        )}
        {/* 文件读写（2026-09-11 手机端补齐；同日顺位调整=移到运行键右侧）：与桌面
            工具栏「导入 .femo / 导出 .femo」同源，收成两枚同款 32×32 图标芯片——
            打开（导入）/保存（导出）。中性灰（textSecondary）以示与运行控制的语义色
            （绿/红/琥珀、强调色）分属两族。
            回调非函数时不渲染（独立模式被裁掉 onImport/onExport 的宿主）。 */}
        {typeof onImport === 'function' && (
          <MobileIconBtn
            onClick={onImport}
            icon={FaFolderOpen}
            color={T.textSecondary}
            title="导入 .femo"
          />
        )}
        {typeof onExport === 'function' && (
          <MobileIconBtn
            onClick={onExport}
            icon={FaFloppyDisk}
            color={T.textSecondary}
            title={exportBusy ? '保存中…' : '导出 .femo'}
            disabled={exportBusy}
          />
        )}

        {/* FEMO 预览切换（2026-09-06 与运行控制键同族化）：同款 32×32 芯片
            造型（圆角/底+边公式/按压反馈全同），但走「视图开关」自己的颜色
            ——开=主题强调色（浅底+细边+微光晕），关=中性灰。与运行键的
            绿/红/琥珀（从头跑·运行 / 停 / 继续）既同族又一眼可辨；颜色全部走主题 CSS
            var，深浅两主题自动换值保持和谐可辨。 */}
        <button
          onClick={onToggleFemo}
          title="FEMO 预览"
          aria-label="FEMO 预览"
          className="femo-mob-icon-btn"
          style={{
            background: femoVisible
              ? `color-mix(in srgb, ${T.accent} 16%, transparent)`
              : `color-mix(in srgb, ${T.textSecondary} 10%, transparent)`,
            border: `var(--femo-border-w) solid ${
              femoVisible
                ? `color-mix(in srgb, ${T.accent} 45%, transparent)`
                : `color-mix(in srgb, ${T.textSecondary} 32%, transparent)`
            }`,
            borderRadius: 'var(--femo-radius-sm)',
            width: 32,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            lineHeight: 0,
            fontSize: 9,
            fontWeight: 800,
            color: femoVisible ? T.accent : T.textSecondary,
            fontFamily: 'var(--femo-font-mono)',
            letterSpacing: '0.02em',
            boxShadow: femoVisible ? '0 0 9px var(--femo-primary-glow-weak, transparent)' : 'none',
            // 内联 transition 会整体覆盖 .femo-mob-icon-btn 的类级 transition，
            // 故按压回缩/提亮（transform/filter）必须在此一并声明。
            transition: 'transform 0.12s ease, filter 0.12s ease, background 0.15s, color 0.15s, box-shadow 0.15s',
          }}
        >
          FEMO
        </button>
      </div>
    </div>
  );
}

// 运行控制图标按钮（2026-09-06 统一重造）：三个状态键（跑/停/从头）同款
// 芯片造型——32×32 圆角方、色 13% 浅底 + 38% 细边、居中 FA 图标（继承按钮
// 文字色）。此前 label 文本符号（▶⏹⟲）字号基线各异，且 color+'22' 拼在
// CSS var 上是非法值、底/边从未渲染过——裸符号随手一摆就是「风格差太远」。
// FA 图标按 viewBox 等比渲染，三个图标光学尺寸天然一致。
function MobileIconBtn({ onClick, icon: Icon, color, title, disabled = false }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="femo-mob-icon-btn"
      style={{
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        border: `var(--femo-border-w) solid color-mix(in srgb, ${color} 38%, transparent)`,
        borderRadius: 'var(--femo-radius-sm)',
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 禁用（导出保存中）：与桌面导出键同款——降透明度 + wait 光标，
        // 防重复提交（onClick 已摘掉，双保险）。
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        color: color,
        flexShrink: 0,
        padding: 0,
        lineHeight: 0,
      }}
    >
      <Icon size={12} />
    </button>
  );
}

// ─────────────────────────────────────────────
// FEMO 预览侧板（右侧全高滑出）
// ─────────────────────────────────────────────
function MobileFemoPanel({ visible, femoText, onChange, femoError, femoDirty, onApply, onRestore, onGraphToFemo, onClose }) {
  // 头排按钮回执状态（2026-09-07 与桌面端同款设计语言）。hooks 必须在
  // `!visible` 早退之前——条件挂载会打乱 hooks 顺序。
  const [copied, setCopied] = useState(false);
  const [g2tFlash, setG2tFlash] = useState(false);
  const [applyFlash, setApplyFlash] = useState(false);
  const copyTimerRef = useRef(null);
  const g2tTimerRef = useRef(null);
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
        await navigator.clipboard.writeText(femoText || '');
        ok = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = femoText || '';
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
  }, [femoText]);

  if (!visible) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--femo-mask)',
          zIndex: 300,
          animation: 'fadeInOverlay 0.18s ease',
        }}
      />
      <div
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: '88vw',
          maxWidth: 420,
          background: 'var(--femo-mobile-bg-2)',
          borderLeft: `var(--femo-border-w) solid ${T.border}`,
          zIndex: 301,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideInFemo 0.22s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: '-8px 0 32px var(--femo-mask)',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: '14px 16px 10px',
            borderBottom: 'var(--femo-border-w) solid var(--femo-mobile-border-strong)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--femo-neutral)', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--femo-font-mono)' }}>
            FEMO 预览
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {femoError && (
              <button onClick={onRestore} style={mobChip(T.warning, true)}>恢复</button>
            )}
            <button
              onClick={handleCopy}
              style={mobChip(copied ? T.success : T.accent, copied)}
            >
              {copied ? '✓ 已复制' : '复制'}
            </button>
            <button
              onClick={() => { onGraphToFemo?.(); flash(setG2tFlash, g2tTimerRef); }}
              style={mobChip(g2tFlash ? T.success : T.accent, g2tFlash)}
            >
              {g2tFlash ? '✓ 已生成' : '图→文'}
            </button>
            <button
              onClick={() => { onApply?.(); flash(setApplyFlash, applyTimerRef); }}
              style={mobChip(
                applyFlash ? (femoError ? T.danger : T.success) : T.accent,
                applyFlash || femoDirty,
              )}
            >
              {applyFlash ? (femoError ? '✕ 失败' : '✓ 已应用') : '文→图'}
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'var(--femo-mobile-border-strong)',
                border: 'none',
                borderRadius: 'var(--femo-radius-sm)',
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--femo-neutral)',
                fontSize: 14,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {femoError && (
          <div style={{ margin: '8px 12px 0', padding: '6px 10px', background: 'var(--femo-mobile-danger-soft)', border: 'var(--femo-border-w) solid var(--femo-mobile-danger-border)', borderRadius: 'var(--femo-radius-sm)', fontSize: 10, color: 'var(--femo-danger-weak)', lineHeight: 1.5 }}>
            {femoError}
          </div>
        )}

        {/* 编辑器 */}
        <textarea
          value={femoText}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            padding: '12px 14px',
            fontFamily: 'var(--femo-font-mono)',
            fontSize: 10.5,
            lineHeight: 1.8,
            color: 'var(--femo-mobile-text-2-alt)',
            touchAction: 'auto',
            userSelect: 'text',
            WebkitUserSelect: 'text',
          }}
        />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// Bottom Panel — Library / Project / Properties
// ─────────────────────────────────────────────

// Tab 定义
const BOTTOM_TABS = [
  { id: 'library', label: '仓库' },
  { id: 'project', label: '项目' },
  { id: 'props', label: '属性' },
  { id: 'settings', label: '设置' },
];

function MobileBottomPanel({
  activeTab,
  onTabChange,
  // Library props
  lib,
  mode,
  locationPath,
  allNames,
  onNew,
  onAdd,
  onAddModule,
  onAddSpecial,
  onAddPosition,
  onEdit,
  onEditModule,
  onDragStart,
  // round49：四个触摸处理器全部面板级（挂在滚动容器上），落点无关——
  // touchstart 用 closest('[data-femo-lib-drag]') 找拖拽目标；move/end 负责仲裁与拖拽。
  onPanelTouchStart,
  onLibTouchMove,
  onLibTouchEnd,
  onLibTouchCancel = null,
  libArmedKey, // round27：长按激活拖拽的条目 key（点亮被按卡片）
  htmlDraggable = false, // 手机端恒 false——draggable 卡片阻止触摸滚动
  onSelectLib,
  onNewModule,
  // Project props
  proj,
  actorNames,
  onProjChange,
  // Props
  sel,
  selNode,
  selEdge,
  selAction,
  nodes,
  edges,
  backEdges,
  nodeStates,
  actionStore,
  onDeleteNode,
  onDeleteEdge,
  onCondChange,
  onEditAction,
  onEnterModuleNode,
  libSel,
  // Settings（设置 tab：主题切换 + 新建 SOUL + 调试窗口）
  themeName,
  onCycleTheme,
  onOpenSoul,
  // Debug（调试窗口：与桌面端共用 debugLog 数据面）
  debugLog = [],
  onClearDebug,
  compilerLog = [],
  onClearCompiler,
  femogenLog = [],
  onClearFemogen,
  hostLog = [],
  onClearHost,
  onCompileDebug,
  compilingDebug = false,
}) {
  const scrollRef = useRef(null);
  // 调试浮层开关（面板内 absolute inset:0 —— 与面板同高，不挡画布）
  const [debugOpen, setDebugOpen] = useState(false);
  const WIN_H = typeof window !== 'undefined' ? window.innerHeight : 700;
  const MIN_H = 100;
  const MAX_H = Math.round(WIN_H * 0.72);
  const DEFAULT_H = Math.round(WIN_H * 0.28);
  const [panelH, setPanelH] = useState(DEFAULT_H);
  const dragHandleRef = useRef(null);
  const dragStartRef = useRef(null); // { y, h }

  // 切换 tab 时滚回顶部
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;  }, [activeTab]);

  // round46/49：仓库触摸四事件全挂**原生**监听——React 根级委派是 passive 的，
  // armed 状态的 preventDefault 在那里无效。touchstart 用 passive:true（我们从不
  // 在 start 阶段拦截，主动向 WebKit 声明"不挡滚动"，换取最快滚动启动路径）；
  // move/end 保持非 passive（armed 拖拽需要 preventDefault）。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onLibTouchMove || !onLibTouchEnd) return;
    if (onPanelTouchStart) el.addEventListener('touchstart', onPanelTouchStart, { passive: true });
    el.addEventListener('touchmove', onLibTouchMove, { passive: false });
    el.addEventListener('touchend', onLibTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onLibTouchCancel || (() => {}), { passive: true });
    return () => {
      if (onPanelTouchStart) el.removeEventListener('touchstart', onPanelTouchStart);
      el.removeEventListener('touchmove', onLibTouchMove);
      el.removeEventListener('touchend', onLibTouchEnd);
      el.removeEventListener('touchcancel', onLibTouchCancel || (() => {}));
    };
  }, [onPanelTouchStart, onLibTouchMove, onLibTouchEnd, onLibTouchCancel]);

  // 鼠标拖拽（桌面调试用）
  const onHandleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, h: panelH };
    const onMove = (mv) => {
      const delta = dragStartRef.current.y - mv.clientY;
      setPanelH(Math.max(MIN_H, Math.min(MAX_H, dragStartRef.current.h + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelH]);

  // 触摸拖拽
  const onHandleTouchStart = useCallback((e) => {
    e.stopPropagation();
    const t = e.touches[0];
    dragStartRef.current = { y: t.clientY, h: panelH };
  }, [panelH]);

  const onHandleTouchMove = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    const t = e.touches[0];
    const delta = dragStartRef.current.y - t.clientY;
    setPanelH(Math.max(MIN_H, Math.min(MAX_H, dragStartRef.current.h + delta)));
  }, []);

  const onHandleTouchEnd = useCallback((e) => {
    e.stopPropagation();
    dragStartRef.current = null;
  }, []);

  return (
    <div
      style={{
        height: panelH,
        background: T.surface,
        borderTop: `var(--femo-border-w) solid ${T.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        position: 'relative',
        zIndex: 50,
        transition: dragStartRef.current ? 'none' : 'height 0.12s ease',
      }}
    >
      {/* 拖拽手柄 */}
      <div
        ref={dragHandleRef}
        onMouseDown={onHandleMouseDown}
        onTouchStart={onHandleTouchStart}
        onTouchMove={onHandleTouchMove}
        onTouchEnd={onHandleTouchEnd}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'ns-resize',
          zIndex: 10,
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 'var(--femo-radius-xs)',
            background: T.borderLight,
            opacity: 0.7,
            marginTop: 6,
          }}
        />
      </div>

      {/* Tab bar（留出手柄空间）*/}
      <div
        style={{
          display: 'flex',
          borderBottom: `var(--femo-border-w) solid ${T.border}`,
          flexShrink: 0,
          background: T.bg,
          marginTop: 18,
        }}
      >
        {BOTTOM_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              borderBottom: activeTab === t.id ? `var(--femo-border-w-selected) solid ${T.accent}` : 'var(--femo-border-w-selected) solid transparent',
              padding: '7px 0',
              fontSize: 11.5,
              fontWeight: activeTab === t.id ? 800 : 500,
              color: activeTab === t.id ? T.accent : T.textMuted,
              cursor: 'pointer',
              fontFamily: 'var(--femo-font-sans)',
              letterSpacing: '0.02em',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {t.label}
            {t.id === 'props' && (sel || libSel) && (
              <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 'var(--femo-radius-pill)', background: T.accent, marginLeft: 4, verticalAlign: 'middle' }} />
            )}
          </button>
        ))}
      </div>

      {/* Scrollable content — 直接复用桌面端原有组件 */}
      <div
        ref={scrollRef}
        className="femo-bottom-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '10px 14px 12px',
          animation: 'fadePanel 0.15s ease',
          minHeight: 0,
          // 让桌面端组件在深色背景下可读
          '--text-primary': T.textPrimary,
          color: 'var(--femo-text-1)',
          background: 'transparent', /* round12/15：去掉圆角卡片底，融入壳背景 */
        }}
      >
        {activeTab === 'library' && (
          <LibPanel
            cardLayout="grid3"
            lib={lib}
            mode={mode}
            locationPath={locationPath}
            allNames={allNames}
            onNew={onNew}
            onAdd={onAdd}
            onAddModule={onAddModule}
            onAddSpecial={onAddSpecial}
            onAddPosition={onAddPosition}
            onEdit={onEdit}
            onEditModule={onEditModule}
            onDragStart={onDragStart}
            armedKey={libArmedKey}
            htmlDraggable={htmlDraggable}
            onSelectLib={onSelectLib}
            onNewModule={onNewModule}
          />
        )}
        {activeTab === 'project' && (
          <ProjPanel
            proj={proj}
            actorNames={actorNames}
            onChange={onProjChange}
          />
        )}
        {activeTab === 'props' && (
          <MobilePropsPanel
            sel={sel}
            selNode={selNode}
            selEdge={selEdge}
            selAction={selAction}
            nodes={nodes}
            edges={edges}
            backEdges={backEdges}
            nodeStates={nodeStates}
            actionStore={actionStore}
            onDeleteNode={onDeleteNode}
            onDeleteEdge={onDeleteEdge}
            onCondChange={onCondChange}
            onEditAction={onEditAction}
            onEnterModuleNode={onEnterModuleNode}
            libSel={libSel}
            lib={lib}
          />
        )}
        {activeTab === 'settings' && (
          <div>
            <div style={sectionLabel}>设置</div>
            {/* 三键同构（2026-09-08 r2）：等宽 flex:1 均衡排布 + FA 图标 + 32px 芯片高度
                （对齐标题栏 MobileIconBtn 家族）；图标 flexShrink:0、文字省略号兜底，
                长主题名（跟随 DSH）不挤爆布局。红点内移（overflow:hidden 会裁掉出界
                部分）：调试键有错时按钮右上角提示。 */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
              <button
                onClick={onCycleTheme}
                title={`主题：点击切换（当前 ${themeName}）`}
                style={mobSettingBtn}
                className="femo-mob-setting-btn"
              >
                <FaPalette size={12} style={{ flexShrink: 0 }} />
                <span style={mobSettingBtnText}>{themeName}</span>
              </button>
              <button
                onClick={onOpenSoul}
                title="新建 SOUL"
                style={mobSettingBtn}
                className="femo-mob-setting-btn"
              >
                <FaUserPlus size={12} style={{ flexShrink: 0 }} />
                <span style={mobSettingBtnText}>新建 SOUL</span>
              </button>
              <button
                onClick={() => setDebugOpen(true)}
                title="调试窗口：后端运行信息与报错的常驻日志流"
                style={mobSettingBtn}
                className="femo-mob-setting-btn"
              >
                <FaTerminal size={12} style={{ flexShrink: 0 }} />
                <span style={mobSettingBtnText}>调试</span>
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
          </div>
        )}
      </div>

      {/* ── 调试窗口浮层：从拖动手柄下方开始（top:20）——盖住 tab 栏与内容区，
          但手柄保持可见可拖：调试开着也能调整底部面板高度（2026-09-08）。── */}
      {debugOpen && (
        <div style={{ position: 'absolute', inset: '20px 0 0 0', zIndex: 60 }}>
          <DebugPanel
            entries={debugLog}
            onClose={() => setDebugOpen(false)}
            onClear={onClearDebug}
            compilerEntries={compilerLog}
            onClearCompiler={onClearCompiler}
            femogenEntries={femogenLog}
            onClearFemogen={onClearFemogen}
            hostEntries={hostLog}
            onClearHost={onClearHost}
            onCompile={onCompileDebug}
            compiling={compilingDebug}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// MobileLibPanel — 仓库面板（横向卡片列表）
// ─────────────────────────────────────────────
function MobileLibPanel({ lib, mode, locationPath, allNames, onNew, onAdd, onAddModule, onAddSpecial, onAddPosition, onEdit, onEditModule, onSelectLib, onNewModule }) {
  const [newModName, setNewModName] = useState('');

  const displayActions = (lib.actions || []).filter((a) => {
    if (!a.path) return false;
    if (a.path.length === 1 && a.path[0] === 'mainflow') return true;
    return locationPath.every((seg, i) => a.path[i] === seg);
  });
  const displayModules = (lib.modules || []).filter(
    (m) =>
      m.path &&
      locationPath.every((seg, i) => m.path[i] === seg) &&
      m.path.length === locationPath.length + 1
  );
  const specialNodes =
    mode === 'mainflow'
      ? [
          { t: 'FOR', c: 'var(--femo-primary-strong)' },
          { t: 'PAR', c: 'var(--femo-special-par)' },
          { t: 'END', c: 'var(--femo-danger)' },
        ]
      : [
          { t: 'FOR', c: 'var(--femo-primary-strong)' },
          { t: 'PAR', c: 'var(--femo-special-par)' },
          { t: 'BREAK', c: 'var(--femo-warning)' },
          { t: 'OUT', c: 'var(--femo-danger)' },
        ];

  return (
    <div>
      {/* Actions 行 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={sectionLabel}>Actions</span>
        <button onClick={onNew} style={{ ...mobBtnP, padding: '3px 10px', fontSize: 10 }}>+ 新建</button>
      </div>
      <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, WebkitOverflowScrolling: 'touch', touchAction: 'pan-x' }}>
        {displayActions.length === 0 ? (
          <div style={{ fontSize: 11, color: T.textMuted, padding: '4px 0' }}>暂无 Action</div>
        ) : displayActions.map((a) => {
          const { c, bg } = ti(a.executorType);
          return (
            <div
              key={a.id}
              onClick={() => onSelectLib?.('action', a.id)}
              style={{
                background: 'var(--femo-node-bg)',
                borderRadius: 'var(--femo-radius-md)',
                border: `var(--femo-node-border-w) solid var(--femo-node-border)`,
                borderLeft: `var(--femo-border-w-accent) solid ${c}`,
                padding: '6px 9px',
                minWidth: 100,
                maxWidth: 140,
                flexShrink: 0,
                cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 700, color: T.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
                {a.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: c, fontFamily: 'var(--femo-font-mono)' }}>@{a.executorType}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onAdd(a); }}
                  style={{ background: 'var(--femo-btn-primary)', border: 'none', borderRadius: 'var(--femo-radius-sm)', color: 'var(--femo-on-accent)', fontSize: 9, fontWeight: 700, padding: '1px 6px', cursor: 'pointer' }}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modules */}
      {displayModules.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 10, marginBottom: 6 }}>Modules</div>
          <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, touchAction: 'pan-x' }}>
            {displayModules.map((m) => (
              <div
                key={m.id}
                onClick={() => onSelectLib?.('module', m.id)}
                style={{
                  background: 'var(--femo-node-bg)',
                  borderRadius: 'var(--femo-radius-md)',
                  border: `var(--femo-node-border-w) solid var(--femo-node-border)`,
                  borderLeft: 'var(--femo-border-w-accent) solid var(--femo-tag-bg)',
                  padding: '6px 9px',
                  minWidth: 100,
                  flexShrink: 0,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textPrimary, marginBottom: 5 }}>&{m.name}</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); onAddModule(m); }}
                    style={{ background: 'var(--femo-btn-primary)', border: 'none', borderRadius: 'var(--femo-radius-sm)', color: 'var(--femo-on-accent)', fontSize: 9, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', flex: 1 }}
                  >
                    +画布
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onEditModule?.(m); }}
                    style={{ background: 'var(--femo-primary)', border: 'none', borderRadius: 'var(--femo-radius-sm)', color: 'var(--femo-on-accent)', fontSize: 9, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', flex: 1 }}
                  >
                    进入
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 新建模块 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
        <input
          value={newModName}
          onChange={(e) => setNewModName(e.target.value)}
          placeholder="新模块名"
          style={{ ...mobInp, flex: 1, fontSize: 11 }}
        />
        <button
          onClick={() => {
            const name = newModName.trim();
            if (name && (!allNames?.has || !allNames.has(name))) {
              onNewModule(name);
              setNewModName('');
            }
          }}
          style={{ ...mobBtnP, padding: '5px 10px', fontSize: 10, flexShrink: 0 }}
        >
          创建
        </button>
      </div>

      {/* 特殊节点 + POSITION */}
      <div style={{ marginTop: 10 }}>
        <div style={sectionLabel}>特殊节点</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {specialNodes.map((s) => {
            const spKey = { START: 'start', IN: 'start', END: 'end', OUT: 'end', BREAK: 'break', FOR: 'for', PAR: 'par' }[s.t] || 'for';
            return (
              <button
                key={s.t}
                onClick={() => onAddSpecial(s.t)}
                style={{
                  background: `var(--femo-sp-${spKey}-bg)`,
                  border: `var(--femo-border-w) solid color-mix(in srgb, ${s.c} 50%, var(--femo-node-bg))`,
                  borderRadius: 'var(--femo-radius-sm)',
                  padding: '4px 10px',
                  fontSize: 10.5,
                  fontWeight: 800,
                  color: s.c,
                  cursor: 'pointer',
                  fontFamily: 'var(--femo-font-mono)',
                }}
              >
                [{s.t}]
              </button>
            );
          })}
          <button
            onClick={onAddPosition}
            style={{
              background: 'var(--femo-neutral-faint)',
              border: 'var(--femo-border-w) solid var(--femo-neutral-border)',
              borderRadius: 'var(--femo-radius-sm)',
              padding: '4px 10px',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--femo-neutral)',
              cursor: 'pointer',
              fontFamily: 'var(--femo-font-mono)',
            }}
          >
            POSITION
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MobileProjPanel — 精简项目信息
// ─────────────────────────────────────────────
function MobileProjPanel({ proj, actorNames, onChange }) {
  if (!proj) return null;
  const u = (x) => onChange({ ...proj, ...x });
  // dsh 可用模型列表（source 下拉数据源）
  const [models, modelErr] = useModelList();
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 2 }}>
          <div style={fieldLabel}>项目名称</div>
          <input value={proj.name || ''} onChange={(e) => u({ name: e.target.value })} style={mobInp} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={fieldLabel}>Version</div>
          <input value={proj.version || ''} onChange={(e) => u({ version: e.target.value })} placeholder="1.0" style={mobInp} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={fieldLabel}>Database</div>
          <input value={proj.database || ''} onChange={(e) => u({ database: e.target.value })} placeholder="memory/..." style={mobInp} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={fieldLabel}>Session</div>
          <input value={proj.session || ''} onChange={(e) => u({ session: e.target.value })} placeholder="new" style={mobInp} />
        </div>
      </div>

      {/* Actors */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={sectionLabel}>Actors</span>
        <button
          onClick={() => u({ actors: [...(proj.actors || []), { name: '', type: 'ai', soul: '', source: '', tools: null, thinking: '' }] })}
          style={{ ...mobBtnP, padding: '2px 8px', fontSize: 10 }}
        >
          +
        </button>
      </div>
      {(proj.actors || []).map((a, i) => {
        const upd = (x) => u({ actors: proj.actors.map((p, j) => (j === i ? { ...p, ...x } : p)) });
        return (
          <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
            <select value={a.type} onChange={(e) => upd({ type: e.target.value })} style={{ ...mobInp, width: 60, fontSize: 10 }}>
              <option value="ai">ai</option>
              <option value="human">human</option>
            </select>
            <input
              value={a.name}
              onChange={(e) => { let v = e.target.value.trim(); if (v && !v.startsWith('@')) v = '@' + v; upd({ name: v }); }}
              placeholder="@Alice"
              style={{ ...mobInp, flex: 1, fontSize: 11 }}
            />
            {a.type === 'ai' && models ? (
              <select
                value={a.source || ''}
                onChange={(e) => upd({ source: e.target.value })}
                style={{ ...mobInp, flex: 1, fontSize: 10 }}
              >
                {sourceOptions(models, a.source).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={a.source}
                onChange={(e) => upd({ source: e.target.value })}
                placeholder={a.type === 'ai' ? (modelErr || 'deepseek') : '数字ID'}
                style={{ ...mobInp, flex: 1, fontSize: 11 }}
              />
            )}
            <button onClick={() => u({ actors: proj.actors.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', color: 'var(--femo-danger-weak)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 2 }}>×</button>
          </div>
        );
      })}

      {/* Vars */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, marginTop: 8 }}>
        <span style={sectionLabel}>Vars</span>
        <button onClick={() => u({ vars: [...(proj.vars || []), { name: '', defaultValue: '' }] })} style={{ ...mobBtnP, padding: '2px 8px', fontSize: 10 }}>+</button>
      </div>
      {(proj.vars || []).map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
          <input value={v.name} onChange={(e) => { const upd = [...proj.vars]; upd[i] = { ...upd[i], name: e.target.value }; u({ vars: upd }); }} placeholder="变量名" style={{ ...mobInp, flex: 1 }} />
          <input value={v.defaultValue} onChange={(e) => { const upd = [...proj.vars]; upd[i] = { ...upd[i], defaultValue: e.target.value }; u({ vars: upd }); }} placeholder="默认值" style={{ ...mobInp, flex: 2 }} />
          <button onClick={() => u({ vars: proj.vars.filter((_, j) => j !== i) })} style={{ background: 'none', border: 'none', color: 'var(--femo-danger-weak)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 2 }}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// MobilePropsPanel — 节点/边属性
// ─────────────────────────────────────────────
function MobilePropsPanel({ sel, selNode, selEdge, selAction, nodes, edges, backEdges, nodeStates, actionStore, onDeleteNode, onDeleteEdge, onCondChange, onEditAction, onEnterModuleNode, libSel, lib }) {
  if (sel?.type === 'node' && selNode) {
    const ns = nodeStates?.[selNode.id] || {};
    const action = selAction;
    const isModuleNode = selNode.type === 'module' && !!selNode.modDef;
    const { c } = action ? ti(action.executorType) : { c: 'var(--femo-neutral)' };
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
          {action && (
            <span style={{ background: `var(--femo-badge-bg-${['ai','human','mind','func','assign','notice'].includes(action.executorType) ? action.executorType : 'ai'})`, color: `var(--femo-badge-fg-${['ai','human','mind','func','assign','notice'].includes(action.executorType) ? action.executorType : 'ai'})`, borderRadius: 'var(--femo-radius-sm)', padding: '2px 7px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--femo-font-mono)' }}>
              @{action.executorType}
            </span>
          )}
          <span style={{ fontSize: 13.5, fontWeight: 800, color: T.textPrimary }}>{action?.name || selNode.specialType || selNode.label || '节点'}</span>
        </div>
        {selNode.label && <MobPropRow k="节点名" v={String(selNode.label).replace(/[\[\]]/g, '')} />}
        {action && (
          <>
            {action.executorActor && <MobPropRow k="执行者" v={action.executorActor} />}
            {action.scope && <MobPropRow k="Scope" v={action.scope} />}
            {action.outVars && <MobPropRow k="出参" v={String(action.outVars)} />}
          </>
        )}
        {ns.status && <MobPropRow k="状态" v={ns.status} />}
        <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
          {action && (
            <button onClick={onEditAction} style={{ ...mobBtnP, flex: 1, fontSize: 11, padding: '6px 0' }}>编辑 Action</button>
          )}
          {isModuleNode && (
            <button
              onClick={() => onEnterModuleNode?.(selNode.id)}
              style={{ ...mobBtnP, flex: 1, fontSize: 11, padding: '6px 0', background: 'var(--femo-primary)' }}
            >进入子画布</button>
          )}
          <button onClick={onDeleteNode} style={{ ...mobBtnDanger, flex: 1, fontSize: 11, padding: '6px 0' }}>删除节点</button>
        </div>
      </div>
    );
  }
  if (sel?.type === 'edge' && selEdge) {
    const isBack = backEdges?.has(selEdge.id);
    const inEdges = edges.filter((e) => e.tgt === selEdge.tgt && !backEdges?.has(e.id));
    return (
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textPrimary, marginBottom: 8 }}>连线属性</div>
        {isBack && <div style={{ fontSize: 10, color: 'var(--femo-primary-strong)', fontWeight: 700, background: 'var(--femo-primary-soft-faint)', borderRadius: 'var(--femo-radius-sm)', padding: '3px 7px', marginBottom: 6 }}>回环检测</div>}
        {inEdges.length > 1 && <div style={{ fontSize: 10, color: T.warning, fontWeight: 700, marginBottom: 6 }}>Join 节点 ({inEdges.length} 入口)</div>}
        <div style={fieldLabel}>if 条件</div>
        <input
          value={selEdge.cond || ''}
          onChange={(e) => onCondChange(e.target.value)}
          placeholder="留空 = 无条件"
          style={{ ...mobInp, marginBottom: 10 }}
        />
        <button onClick={onDeleteEdge} style={{ ...mobBtnDanger, width: '100%', fontSize: 11, padding: '6px 0' }}>删除连线</button>
      </div>
    );
  }
  if (libSel) {
    let item = null;
    if (libSel.type === 'action') item = lib?.actions?.find((a) => a.id === libSel.id);
    else if (libSel.type === 'module') item = lib?.modules?.find((m) => m.id === libSel.id);
    if (item) {
      return (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary, marginBottom: 8 }}>
            {libSel.type === 'module' ? `&${item.name}` : item.name}
          </div>
          {libSel.type === 'action' && (
            <>
              <MobPropRow k="类型" v={`@${item.executorType}`} />
              {item.executorActor && <MobPropRow k="执行者" v={item.executorActor} />}
            </>
          )}
        </div>
      );
    }
  }
  return (
    <div style={{ color: T.textMuted, fontSize: 12, lineHeight: 1.8, paddingTop: 4 }}>
      点击节点或连线查看属性
      <br />
      <span style={{ fontSize: 10.5, color: T.textMuted }}>双击节点可编辑；双击模块节点进入其子画布</span>
    </div>
  );
}

function MobPropRow({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11.5, marginBottom: 5 }}>
      <span style={{ color: T.textMuted, minWidth: 44, flexShrink: 0 }}>{k}</span>
      <span style={{ color: T.textPrimary, fontFamily: 'var(--femo-font-mono)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
}

// ─────────────────────────────────────────────
// BubbleOverlay 手机适配版
// ─────────────────────────────────────────────
function MobileBubbleOverlay({ bubbleOverlay, nodes, nodeStates, actionStore, onClose, submitHumanInput }) {
  if (!bubbleOverlay) return null;
  const node = nodes.find((n) => n.id === bubbleOverlay.nodeId);
  if (!node || node.type !== 'action') return null;
  const action = actionStore?.find((a) => a.id === node.actionId);
  const ns = nodeStates[node.id] || {};
  // mind 节点按运行时 node_type 判断（node_start 事件写入 ns.type）：
  // 执行者运行时才确定（可能是变量赋值），静态 executorType 无法预判；
  // 未运行（ns.type 空）时回退到静态 executorType。
  const runType = ns.type || action?.executorType;
  const isAI = runType === 'ai';
  const isHuman = runType === 'human';
  const isStreaming = ns.status === 'ai_streaming';
  const { c } = ti(action?.executorType) || { c: 'var(--femo-neutral)' };
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [ns.streamingText, ns.output]);

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'var(--femo-mask-heavy)', zIndex: 500, animation: 'fadeInOverlay 0.18s ease' }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(92vw, 460px)',
          maxHeight: '78vh',
          background: 'var(--femo-surface)',
          borderRadius: 'var(--femo-radius-xl)',
          boxShadow: '0 24px 64px var(--femo-mask-soft)',
          border: `var(--femo-border-w-selected) solid ${c}`,
          fontFamily: 'var(--femo-font-sans)',
          zIndex: 501,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'popIn 0.2s cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        {/* 头部 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: 'var(--femo-border-w) solid var(--femo-border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ background: c + '18', color: c, borderRadius: 'var(--femo-radius-sm)', padding: '2px 7px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--femo-font-mono)' }}>
              @{action?.executorType || '?'}
            </span>
            <span style={{ fontWeight: 800, color: 'var(--femo-text-1)', fontSize: 15 }}>{action?.name || 'Node'}</span>
          </div>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ background: 'var(--femo-bg-2)', border: 'none', fontSize: 15, cursor: 'pointer', color: 'var(--femo-text-2-alt)', borderRadius: 'var(--femo-radius-md)', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* 内容 */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', lineHeight: 1.65, fontSize: 13, color: 'var(--femo-text-1)', touchAction: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {ns.context && <div style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{ns.context}</div>}
          {ns.showprompt && (
            <div style={{ marginBottom: 10, background: 'var(--femo-bg)', padding: '8px 10px', borderRadius: 'var(--femo-radius-md)' }}>
              <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 3, fontSize: 10.5 }}>[节点提示]</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.showprompt}</div>
            </div>
          )}
          {isHuman && ns.prompt && (
            <div style={{ marginBottom: 10, background: 'var(--femo-bg)', padding: '8px 10px', borderRadius: 'var(--femo-radius-md)' }}>
              <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 3, fontSize: 10.5 }}>[提示]</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.prompt}</div>
            </div>
          )}
          {runType === 'notice' && (ns.output || ns.prompt) && (
            <div style={{ marginBottom: 10, background: 'var(--femo-bg)', padding: '8px 10px', borderRadius: 'var(--femo-radius-md)' }}>
              <div style={{ fontWeight: 700, color: 'var(--femo-text-3)', marginBottom: 3, fontSize: 10.5 }}>[公告]</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.output || ns.prompt}</div>
            </div>
          )}
          {isAI && (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>[{ns.ai_name || 'AI'}]:</div>
              {isStreaming ? (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                  {ns.streamingText || ''}
                  <span className="mob-cursor" style={{ fontWeight: 'bold', color: c }}>|</span>
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ns.output || '（等待输出）'}</div>
              )}
            </div>
          )}
        </div>

        {/* 人类输入 */}
        {isHuman && ns.status === 'human_wait' && (
          <MobileHumanInput nodeId={node.id} onSubmit={submitHumanInput} outVars={ns.outVars || []} />
        )}
      </div>
    </>
  );
}

function MobileHumanInput({ nodeId, onSubmit, outVars }) {
  const [chatText, setChatText] = useState('');
  const [varValues, setVarValues] = useState({});

  const handleSend = () => {
    if (!chatText.trim() && !Object.values(varValues).some((v) => v?.trim())) return;
    const assignments = {};
    for (const [k, v] of Object.entries(varValues)) {
      if (v?.trim()) assignments[k] = v.trim();
    }
    onSubmit(nodeId, chatText.trim(), assignments);
    setChatText('');
    setVarValues({});
  };

  return (
    <div style={{ flexShrink: 0, padding: '10px 14px 16px', borderTop: 'var(--femo-border-w) solid var(--femo-border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--femo-warning)', marginBottom: 6 }}>⏳ 等待人类输入</div>
      <textarea
        value={chatText}
        onChange={(e) => setChatText(e.target.value)}
        placeholder="输入回复..."
        rows={3}
        style={{
          ...inp,
          resize: 'none',
          width: '100%',
          boxSizing: 'border-box',
          fontSize: 13,
          touchAction: 'auto',
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      />
      <div style={{ display: 'flex', gap: 7, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={handleSend} style={{ ...mobBtnP, padding: '7px 18px', fontSize: 12 }}>发送</button>
        {outVars.map((varName) => (
          <div key={varName} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--femo-text-3)', fontFamily: 'var(--femo-font-mono)' }}>{varName}:</span>
            <input
              value={varValues[varName] || ''}
              onChange={(e) => setVarValues((p) => ({ ...p, [varName]: e.target.value }))}
              placeholder="值"
              style={{ ...inp, width: 90, fontSize: 11, padding: '4px 7px' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// useMobileCanvasGesture — round56 触摸仲裁 v3
// 状态机：idle → pending → nodeDrag / conn / canvasPan / pinch
//
// v2 的三个硬伤（2026-09-08 CDP 真实触摸管线实测，脚本在 _diag-femogen-pinch/）：
//   ① pinch 配对取 e.touches[0]/[1]——那是「全页面最老的两根触点」，不是
//      「本次捏合的两指」。画布外多任何第三触点（搭在面板上的手指、握机
//      手掌误触）都配错对：一根手指被完全无视、缩放几乎不动、画布随
//      「静态触点↔手指」中点大幅漂移（实测 scale 1.00→1.07，应到 1.76）。
//   ② 双指之一落在面板/标题栏时，其 touchstart 不经画布冒泡，phase 永远
//      进不了 pinch；画布上那根手指 200ms 后转 canvasPan，move 又因
//      ts.length!==1 直接 return——缩放平移全死（实测 0 次缩放提交）。
//   ③ 无 touchcancel 处理：浏览器接管手势（原生滚动等）发 cancel 后状态机
//      残留，直到所有手指抬起才能恢复。
//
// v3 方案：
//   - 登记制：只有落点在画布内的触点进 canvasTouchesRef（Set 保持落屏序，
//     值为 touch.identifier）。面板/标题栏触点从根上不参与画布手势，
//     也不会毒化状态机。
//   - pinch 锁定最近落下的两根画布触点的 id；move 只按这两个 id 从
//     e.touches 取实时坐标，第三根手指彻底无视。丢指按剩余画布触点降级：
//     2→重锁续捏、1→转平移、0→复位。
//   - touchcancel 一律清场（清计时器/选中环/连线预览），不产生轻点选择
//     等副作用。
//   - 捏合/平移帧 transform ref 直写 DOM（round47 ghost 同款思路），
//     手势结束才 flush 回 React state——此前每个 touchmove 都 setPan+
//     setScale 触发 FemoWorAuto 整树重渲染（canvasContent 无 memo），是
//     手机端捏合掉帧的主因。
// ─────────────────────────────────────────────
const LONG_PRESS_MS = 200;
// ── round49 仓库触摸仲裁 v2 常量：落点不参与裁决，只认位移与静止 ──
const LIB_LONG_PRESS_MS = 300;    // 长按武装时限（比画布略长，区分"点选"与"拖"意图）
const LIB_SCROLL_COMMIT_PX = 8;   // 位移防抖阈值：任一轴累计 ≥8px → 永判滚动，本手势绝不再拦截
const LIB_DRAG_SLOP_PX = 4;       // 武装允许的累计漂移上限
const LIB_STILL_MS = 120;         // 武装前要求最近 N ms 完全没动——慢速滚动必然被拒，根治"滑着滑着被劫持"
const LIB_ARM_RECHECK_MS = 150;   // 未达静止条件的顺延复查间隔
const LIB_ARM_MAX_WAIT_MS = 900;  // 顺延武装总上限（超时放弃，交还原生滚动）
const MOVE_THRESHOLD = 5;
const NODE_TOUCH_PAD = 12;     // 画布节点命中判定外扩（屏幕像素）——小节点更好碰

function useMobileCanvasGesture({
  cvRef, tfRef,
  pan, setPan, scale, setScale,
  handlePortDown, handlePortUp, setConn,
  nodes, setNodes, setDrag, setSel,
  onBubbleClick,
  onNodeDoubleTap,
}) {
  const stateRef  = useRef({ phase: 'idle' });
  const pinchRef  = useRef({ dist: 0, x: 0, y: 0 });
  const startRef  = useRef({ x: 0, y: 0 });
  const timerRef  = useRef(null);
  // 双击检测：记录上次轻点的节点与时刻——同节点 300ms 内两次轻点=双击
  // （对齐桌面端 onDoubleClick 语义：module 进子画布 / action 开编辑弹窗）。
  const lastTapRef = useRef(null);
  const [dragReady, setDragReady] = useState(null);
  // round56：画布内活跃触点登记（touch.identifier，Set 迭代序=落屏序）
  const canvasTouchesRef = useRef(new Set());

  // 用 ref 持有最新 pan/scale/nodes，彻底避免闭包陈旧。
  // round56：手势进行中（pinch/canvasPan 直写 DOM 时）ref 是唯一事实源，
  // 不再被 props 回写——否则手势中途任何一次无关渲染都会把手势内部的
  // 基线拖回旧值，画面回跳一帧。
  const panRef   = useRef(pan);
  const scaleRef = useRef(scale);
  const nodesRef = useRef(nodes);
  useEffect(() => { if (stateRef.current.phase === 'idle') panRef.current = pan; },    [pan]);
  useEffect(() => { if (stateRef.current.phase === 'idle') scaleRef.current = scale; }, [scale]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // 回调经 ref 中转：原生监听只挂一次，不随 props 身份变化重挂/漏更新
  const apiRef = useRef({});
  useEffect(() => {
    apiRef.current = { setPan, setScale, setSel, setNodes, setConn, setDrag, handlePortDown, handlePortUp, onBubbleClick, onNodeDoubleTap };
  });

  const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid2  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const findTouch = (list, id) => {
    for (let i = 0; i < list.length; i += 1) if (list[i].identifier === id) return list[i];
    return null;
  };
  const clearTimer = () => { clearTimeout(timerRef.current); timerRef.current = null; };

  // round56：捏合/平移帧直写 DOM（transform），手势结束 flush
  // （2026-09-11：缩放比例徽标已按用户点名摘除，此处不再直写任何徽标文案）
  const applyTransform = (x, y, s) => {
    panRef.current = { x, y };
    scaleRef.current = s;
    if (tfRef?.current) tfRef.current.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  const flushTransform = () => {
    apiRef.current.setPan(panRef.current);
    apiRef.current.setScale(scaleRef.current);
  };

  // DOM hit-test：找节点体、端口、连线热区或运行时小气泡
  const hitTest = (cx, cy) => {
    const el = document.elementFromPoint(cx, cy);
    if (el) {
      const portEl = el.closest('[data-port-node]');
      if (portEl) return {
        type: 'port',
        nodeId: portEl.dataset.portNode,
        portDir: portEl.dataset.portDir || 'right',
        portX: portEl.dataset.portX ? parseFloat(portEl.dataset.portX) : undefined,
        portY: portEl.dataset.portY ? parseFloat(portEl.dataset.portY) : undefined,
      };
      // 运行时小气泡（节点上方）——须在 node 之前判（气泡是节点的 DOM 后代，closest 都会命中 node-id）
      const bubbleEl = el.closest('[data-bubble-node]');
      if (bubbleEl) return { type: 'bubble', nodeId: bubbleEl.dataset.bubbleNode };
      const nodeEl = el.closest('[data-node-id]');
      if (nodeEl) return { type: 'node', nodeId: nodeEl.dataset.nodeId };
      // round26：连线热区路径带 data-edge-id，手机端点边不再依赖合成 click
      const edgeEl = el.closest('[data-edge-id]');
      if (edgeEl) return { type: 'edge', id: edgeEl.dataset.edgeId };
    }
    // round25：扩大命中——节点矩形外扩 NODE_TOUCH_PAD（屏幕像素转画布坐标），小节点更好碰
    const rect = cvRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const s = scaleRef.current || 1;
    const p = panRef.current;
    const wx = (cx - rect.left - p.x) / s;
    const wy = (cy - rect.top - p.y) / s;
    const pad = NODE_TOUCH_PAD / s;
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i];
      const { w, h } = getNodeSize(n);
      if (wx >= n.x - pad && wx <= n.x + w + pad && wy >= n.y - pad && wy <= n.y + h + pad) {
        return { type: 'node', nodeId: n.id };
      }
    }
    return null;
  };

  const fakeEv = (cx, cy) => ({
    clientX: cx, clientY: cy, button: 0,
    stopPropagation: () => {}, preventDefault: () => {}, target: null,
  });

  // 锁定「最近落下的两根仍存活的画布触点」进入 pinch（基线取当前间距/中点）
  const enterPinch = (e) => {
    const ids = [...canvasTouchesRef.current].filter((id) => findTouch(e.touches, id));
    if (ids.length < 2) return false;
    const [idA, idB] = ids.slice(-2);
    const ta = findTouch(e.touches, idA);
    const tb = findTouch(e.touches, idB);
    if (!ta || !tb) return false;
    stateRef.current = { phase: 'pinch', idA, idB };
    pinchRef.current = { dist: dist2(ta, tb), ...mid2(ta, tb) };
    setDragReady(null);
    return true;
  };

  useEffect(() => {
    const el = cvRef.current;
    if (!el) return undefined;

    const onTouchStart = (e) => {
      // round55 语义收编：画布触点在源头取消默认行为（原生长按选字/放大镜/
      // 合成鼠标事件），顺手把已聚焦输入框收起来；非画布触点零干预，
      // 面板原生滚动完全不受影响。React 17+ 根级合成 touch 事件是 passive
      // 的，preventDefault 必须走这条原生非 passive 监听。
      let canvasChanged = null;
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        if (el.contains(e.changedTouches[i].target)) { canvasChanged = e.changedTouches[i]; break; }
      }
      if (!canvasChanged) return; // 面板/标题栏触点：画布手势层不参与也不干扰
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) ae.blur();
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        const t = e.changedTouches[i];
        if (el.contains(t.target)) canvasTouchesRef.current.add(t.identifier);
      }

      const st = stateRef.current;
      // —— 双指缩放入口：画布内触点 ≥2 即锁双指，无论落屏先后、无论当前
      //    处于 pending/nodeDrag/conn/canvasPan 哪个相位（长按到一半也能
      //    直接改捏合，这正是真机最常见的起手式）——
      if (canvasTouchesRef.current.size >= 2) {
        clearTimer();
        if (st.phase === 'conn') apiRef.current.setConn(null); // 连线预览不残留
        enterPinch(e);
        return;
      }
      if (st.phase !== 'idle') return; // 单指手势在途，新触点不重入

      // —— 单指起手：只认画布内触点 ——
      const t = canvasChanged;
      startRef.current = { x: t.clientX, y: t.clientY };
      stateRef.current = { phase: 'pending', id: t.identifier, cx: t.clientX, cy: t.clientY };
      setDragReady(null);

      // 长按计时：判断命中目标后切换阶段
      timerRef.current = setTimeout(() => {
        const s0 = stateRef.current;
        if (s0.phase !== 'pending') return;
        const { cx, cy } = s0;
        const hit = hitTest(cx, cy);

        if (hit?.type === 'port') {
          stateRef.current = { phase: 'conn', id: s0.id, srcNodeId: hit.nodeId };
          navigator.vibrate?.(12);
          apiRef.current.handlePortDown(fakeEv(cx, cy), hit.nodeId, hit.portDir, hit.portX, hit.portY);

        // 长按在节点体或其小气泡上 = 拖动该节点（气泡视觉上属于节点，桌面端按住气泡同样触发节点拖拽）
        } else if (hit?.type === 'node' || hit?.type === 'bubble') {
          const node = nodesRef.current.find((n) => n.id === hit.nodeId);
          if (!node) return;
          navigator.vibrate?.(18);
          setDragReady(hit.nodeId);
          apiRef.current.setSel({ type: 'node', id: hit.nodeId });
          stateRef.current = {
            phase: 'nodeDrag',
            id: s0.id,
            nodeId: hit.nodeId,
            startCx: cx, startCy: cy,
            startNx: node.x, startNy: node.y,
          };

        } else {
          stateRef.current = { phase: 'canvasPan', id: s0.id, cx, cy };
        }
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e) => {
      // 能到达本监听的 touchmove 目标必在画布内（监听挂画布元素上），
      // preventDefault 与 round55 语义一致
      e.preventDefault();
      const st = stateRef.current;

      // 双指捏合缩放 + 平移：只看锁定的两根手指，页面上其他手指彻底无视
      if (st.phase === 'pinch') {
        const ta = findTouch(e.touches, st.idA);
        const tb = findTouch(e.touches, st.idB);
        if (!ta || !tb) return; // 参与者少了一根：等 end/cancel 统一收尾
        const d    = dist2(ta, tb);
        const m    = mid2(ta, tb);
        const ratio = d / (pinchRef.current.dist || d);
        const rect  = el.getBoundingClientRect();
        const p = panRef.current, s = scaleRef.current;
        const mxr = m.x - rect.left, myr = m.y - rect.top;
        const wx = (mxr - p.x) / s,  wy = (myr - p.y) / s;
        const ns = Math.min(3, Math.max(0.2, s * ratio));
        applyTransform(
          mxr - wx * ns + (m.x - pinchRef.current.x),
          myr - wy * ns + (m.y - pinchRef.current.y),
          ns,
        );
        pinchRef.current = { dist: d, x: m.x, y: m.y };
        return;
      }

      // 其余相位只跟随「起手那根手指」，其他手指的 move 一律无视
      const t = st.id !== undefined ? findTouch(e.touches, st.id) : null;
      if (!t) return;

    // pending：快速滑动直接进入平移，不等长按
      if (st.phase === 'pending') {
        const dx = t.clientX - startRef.current.x;
        const dy = t.clientY - startRef.current.y;
        if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
          clearTimer();
          stateRef.current = { phase: 'canvasPan', id: st.id, cx: t.clientX, cy: t.clientY };
        }
        return;
      }

      // 节点拖拽：直接算 delta，调 setNodes（FOR↔for_out 联动与桌面端共用一份定义）
      if (st.phase === 'nodeDrag') {
        setDragReady(null);
        const sc = scaleRef.current;
        const newX = st.startNx + (t.clientX - st.startCx) / sc;
        const newY = st.startNy + (t.clientY - st.startCy) / sc;
        apiRef.current.setNodes((prev) => {
          const draggedNode = prev.find((n) => n.id === st.nodeId);
          if (!draggedNode) return prev;
          return applyForLinkage(prev, draggedNode, newX, newY);
        });
        return;
      }

      // 连线：更新 conn.mx/my
      if (st.phase === 'conn') {
        const p   = panRef.current;
        const sc  = scaleRef.current;
        const rect = el.getBoundingClientRect();
        const mx = (t.clientX - rect.left - p.x) / sc;
        const my = (t.clientY - rect.top  - p.y) / sc;
        apiRef.current.setConn((prev) => (prev ? { ...prev, mx, my } : prev));
        return;
      }

      // 画布平移：直写 DOM，不起 React 渲染
      if (st.phase === 'canvasPan') {
        applyTransform(
          panRef.current.x + (t.clientX - st.cx),
          panRef.current.y + (t.clientY - st.cy),
          scaleRef.current,
        );
        st.cx = t.clientX;
        st.cy = t.clientY;
        return;
      }
    };

    const finishGesture = (e) => {
      const cancelled = e.type === 'touchcancel';
      clearTimer();
      setDragReady(null);

      // 登记表摘除已结束触点；统计仍存活的画布触点（e.touches 为准）
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        canvasTouchesRef.current.delete(e.changedTouches[i].identifier);
      }
      const alive = [];
      for (let i = 0; i < e.touches.length; i += 1) {
        if (canvasTouchesRef.current.has(e.touches[i].identifier)) alive.push(e.touches[i]);
      }
      const removedIds = new Set();
      for (let i = 0; i < e.changedTouches.length; i += 1) removedIds.add(e.changedTouches[i].identifier);

      const st = stateRef.current;

      // —— pinch 收尾 ——
      if (st.phase === 'pinch') {
        if (removedIds.has(st.idA) || removedIds.has(st.idB)) {
          if (cancelled) {
            // 系统收走手势：直接复位（手指重新起手即可恢复），flush 定格
            flushTransform();
            stateRef.current = { phase: 'idle' };
          } else if (alive.length >= 2) {
            // 三指捏合抬一指：重锁最近两根继续
            enterPinch(e);
          } else if (alive.length === 1) {
            flushTransform();
            stateRef.current = { phase: 'canvasPan', id: alive[0].identifier, cx: alive[0].clientX, cy: alive[0].clientY };
          } else {
            flushTransform();
            stateRef.current = { phase: 'idle' };
          }
        }
        // 抬的是第三指：pinch 继续，不动
        return;
      }

      // —— 单指相位：只有起手手指的 end 才收尾 ——
      const mine = cancelled ? null : Array.from(e.changedTouches).find((t) => t.identifier === st.id);

      if (st.phase === 'conn') {
        if (cancelled) {
          apiRef.current.setConn(null); // 系统收走：放弃连线预览
        } else if (mine) {
          const hit = hitTest(mine.clientX, mine.clientY);
          if (hit?.nodeId && hit.nodeId !== st.srcNodeId) {
            apiRef.current.handlePortUp(fakeEv(mine.clientX, mine.clientY), hit.nodeId, hit.portDir || 'left');
          } else {
            apiRef.current.setConn(null);
          }
        }
        if (cancelled || mine) stateRef.current = { phase: 'idle' };
        return;
      }

      if (st.phase === 'nodeDrag') {
        apiRef.current.setDrag(null);
        stateRef.current = { phase: 'idle' };
        return;
      }

      // pending 抬手 = 短按（点击）：开气泡 / 选中节点/连线 / 取消选中；
      // touchcancel 是系统收走，绝不产生选择副作用
      if (st.phase === 'pending') {
        if (cancelled) {
          stateRef.current = { phase: 'idle' };
          return;
        }
        if (!mine) return;
        const hit = hitTest(mine.clientX, mine.clientY);
        if (hit?.type === 'bubble') {
          // 轻点运行时小气泡 = 打开气泡弹层（对齐桌面端 onClick→onBubbleClick；不改 sel，与桌面一致）
          apiRef.current.onBubbleClick?.(hit.nodeId);
        } else if (hit?.type === 'node') {
          // 双击判定：同节点 300ms 内两次轻点 → 双击回调（module 进子画布 /
          // action 开编辑弹窗，由宿主分发）；否则记为首次轻点并照常选中。
          const now = performance.now();
          const lt = lastTapRef.current;
          if (lt && lt.nodeId === hit.nodeId && now - lt.t < 300) {
            lastTapRef.current = null;
            apiRef.current.onNodeDoubleTap?.(hit.nodeId);
          } else {
            lastTapRef.current = { nodeId: hit.nodeId, t: now };
            apiRef.current.setSel({ type: 'node', id: hit.nodeId });
          }
        } else if (hit?.type === 'edge') {
          apiRef.current.setSel({ type: 'edge', id: hit.id });
        } else {
          apiRef.current.setSel(null);
        }
        stateRef.current = { phase: 'idle' };
        return;
      }

      if (st.phase === 'canvasPan') {
        flushTransform();
        if (!cancelled && mine && alive.length >= 1) {
          // 换指续平移（旧版语义）
          const t0 = alive[0];
          stateRef.current = { phase: 'canvasPan', id: t0.identifier, cx: t0.clientX, cy: t0.clientY };
        } else {
          stateRef.current = { phase: 'idle' };
        }
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', finishGesture, { passive: false });
    el.addEventListener('touchcancel', finishGesture, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', finishGesture);
      el.removeEventListener('touchcancel', finishGesture);
      canvasTouchesRef.current.clear();
      stateRef.current = { phase: 'idle' };
    };
  }, [cvRef]);

  return { dragReady };
}


// ─────────────────────────────────────────────
// MobileLayout — 根组件，接收桌面端所有 props
// ─────────────────────────────────────────────
/**
 * 用法（在 FemoWorAuto.jsx 内检测 isMobile 后替换渲染）：
 *
 * <MobileLayout
 *   // 项目
 *   proj={proj}
 *   actorNames={actorNames}
 *   onProjChange={setProj}
 *   // 画布
 *   cvRef={cvRef}
 *   pan={pan}   setPan={setPan}
 *   scale={scale}  setScale={setScale}
 *   nodes={nodes}  edges={edges}
 *   canvasContent={<> {svgLayer} {nodeLayer} </>}
 *   // 交互
 *   sel={sel}  setSel={setSel}
 *   drag={drag}  conn={conn}  isPanning={isPanning}
          onMM={onMM}
          onMU={onMU}
          onCanvasDown={onCanvasDown}
          handleWheel={handleWheel}
          handlePortDown={handlePortDown}
          handlePortUp={handlePortUp}
          handleBodyMouseUp={handleBodyMouseUp}
setDrag={setDrag}
          setConn={setConn}
          setNodes={setNodes}
          handleCanvasDragOver={handleCanvasDragOver}
          handleCanvasDrop={handleCanvasDrop}
 *   // 库
 *   lib={lib}  mode={mode}  locationPath={locationPath}  allNames={allNames}
 *   onNew={...}  onAdd={...}  ... (所有 LibPanel 的 props)
 *   // 运行
 *   flowStatus={flowStatus}  hasActiveRunningNodes={hasActiveRunningNodes}
 *   onRun={handleRunWorkflow（恒定 reset:从头）}  onStop={handleStopWorkflow}  onResume={handleResumeWorkflow}
 *   nodeStates={nodeStates}  actionStore={actionStore}  activeNodeIds={activeNodeIds}
 *   // 气泡
 *   bubbleOverlay={bubbleOverlay}  onBubbleClose={handleBubbleClose}  submitHumanInput={submitHumanInput}
 *   // FEMO
 *   femoText={femoText}  onFemoChange={...}  femoError={femoError}  femoDirty={femoDirty}
 *   onApplyFemo={handleApplyFemo}  onRestoreFemo={handleRestoreFemo}  onGraphToFemo={handleGraphToFemo}
 *   // 模态框触发
 *   onOpenApiKey={() => setApiKeyModalOpen(true)}
 *   onOpenSoul={() => setSoulModalOpen(true)}
 *   // 画布内容透明度
 *   canvasOpacity={canvasOpacity}
 * />
 */
function MobileLayout({
  // Theme
  theme = 'dsh',
  // 全屏层（插件模式手机端全屏沉浸用）：fixedMode=false 时降级为容器内 absolute
  zIndex,
  fixedMode = true,
  // 返回键（插件模式：打开 dsh 边栏；独立模式不传）
  onBack,
  // 全屏键（插件模式容器内态：回全屏沉浸；独立模式不传）
  onExpand,
  // Project
  proj, actorNames, onProjChange,
  // Canvas core
  cvRef, pan, setPan, scale, setScale,
  nodes, edges, sel, setSel,
drag, setDrag, conn, setConn, isPanning, setNodes,
  onMM, onMU, onCanvasDown, handleWheel,
  handlePortDown, handlePortUp, handleBodyMouseUp,
  handleCanvasDragOver, handleCanvasDrop,
  canvasContent, canvasOpacity,
  // Library
  lib, mode, locationPath, allNames,
  onNew, onAdd, onAddModule, onAddSpecial, onAddPosition,
  onEdit, onEditModule, onDragStart, onSelectLib, onNewModule,
  libSel,
  // Runtime
  flowStatus, hasActiveRunningNodes,
  onRun, onStop, onResume,
  nodeStates, actionStore, activeNodeIds, errorNodeIds,
  // Bubble
  bubbleOverlay, onBubbleClose, submitHumanInput, humanWaits,
  onBubbleClick,
  // FEMO
  femoText, onFemoChange, femoError, FEMOrnings, femoDirty,
  onApplyFemo, onRestoreFemo, onGraphToFemo,
  // 文件读写（2026-09-11 手机端补齐）：导入/导出回调 + 导出进行中/成功回执。
  // 与桌面工具栏同源（FemoWorAuto 的 handleToolbarImport / handleToolbarExport），
  // 手机端只换呈现（图标芯片 + 标题栏下方 toast），行为完全一致。
  onImport, onExport, exportBusy, exportToast,
  // Modals
  onOpenSoul,
  // 设置（设置 tab：主题切换 + 新建 SOUL）
  themeName, onCycleTheme,
  // 调试窗口（设置 tab 打开；数据面与桌面端同源）
  debugLog, onClearDebug,
  compilerLog, onClearCompiler,
  femogenLog, onClearFemogen,
  hostLog, onClearHost,
  onCompileDebug, compilingDebug,
  // Selection helpers
  backEdges,
  onDeleteNode, onDeleteEdge, onCondChange, onEditAction,
  // Module 子画布导航（2026-09-06 手机端补齐）：双击节点分发 / 返回上级 /
  // 属性面板「进入子画布」。
  onNodeDoubleTap, onNavigatePath, onEnterModuleNode,
}) {
  const [femoVisible, setFemoVisible] = useState(false);
  const [bottomTab, setBottomTab] = useState('library');
  // round56：捏合/平移帧 transform 直写 DOM 的挂点（手势结束才 flush 回 state）
  const tfRef = useRef(null);

  // 当选中节点/边时，自动切换到属性 tab
  useEffect(() => {
    if (sel) setBottomTab('props');
  }, [sel]);

// 触摸手势（round56：钩子内部自挂原生监听，不再经 React 合成事件）
const { dragReady } = useMobileCanvasGesture({
    cvRef, tfRef, pan, setPan, scale, setScale,
    handlePortDown, handlePortUp, setConn,
    nodes, setNodes, setDrag, setSel,
    onBubbleClick,
    onNodeDoubleTap,
  });
  // ── 从仓库触摸拖拽放置节点（round49 仲裁 v2：落点不参与裁决） ──
  // 手势状态机：pending →（任一轴累计 ≥8px）scroll：彻底放手给原生 pan-y，绝不再拦截
  //                    →（静止满 300ms：累计 ≤4px 且最近 120ms 无位移）drag：preventDefault 拖 ghost
  // 落点仅用于 touchstart 时 closest('[data-femo-lib-drag]') 找"拖哪个"；
  // 空白处/输入框/按钮落点连计时器都不启动，行为与纯原生滚动完全一致。
  // 根因注记（v1 卡死）：旧版按落点逐卡挂监听，300ms 内位移 ≤4px 即武装——轻缓起手的
  // 滚动被误判成长按，armed 后 preventDefault 把进行中的原生滚动当场掐死（列表冻结）。
  const libDragRef = useRef(null); // { phase:'pending'|'drag', type, item, startX, startY, lastX, lastY, lastMoveAt, bornAt }
  const libTimerRef = useRef(null);
  // round47：ghost 改为 **ref 直写 DOM**——touchmove 里 setState 会重渲染
  // 整棵编辑器树（主线程卡死，WebKit 来不及启动滚动=卡片滑不动的重要共犯）。
  // 只有"armed 开关"保留 state 变更（驱动画布放置提示 + 抓起卡片高亮）。
  const [libDragActive, setLibDragActive] = useState(false);
  const ghostRef = useRef(null);
  const ghostLabelRef = useRef(null);
  // round27：长按激活视觉反馈——当前被抓起条目的 key（"type:id"），null=无。
  // 激活瞬间 set，touchEnd/取消清；透传 LibPanel 点亮被按卡片 + 画布浮现可放置提示。
  const [libArmedKey, setLibArmedKey] = useState(null);
  // round49：item 对象经 ref 解析（lib 数组常变，避免闭包陈旧）
  const libRef = useRef(lib);
  useEffect(() => { libRef.current = lib; }, [lib]);

  // 面板级 touchstart（passive，绝不 preventDefault）：
  // 找拖拽候选并启动长按武装计时；非候选落点零干预。
  const handlePanelTouchStart = useCallback((e) => {
    if (libDragRef.current) return; // 已有手势在途（多指），不覆盖
    const t = e.touches[0];
    if (!t || !t.target) return;
    // 打字/按钮落点：与拖拽无关，保持纯原生行为
    if (t.target.closest && t.target.closest('input, textarea, select, button')) return;
    const card = t.target.closest ? t.target.closest('[data-femo-lib-drag]') : null;
    if (!card) return; // 空白处：无候选，纯滚动路径
    const raw = card.getAttribute('data-femo-lib-drag') || '';
    const sep = raw.indexOf(':');
    if (sep <= 0) return;
    const type = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    let item = null;
    if (type === 'action') item = (libRef.current?.actions || []).find((x) => x.id === id);
    else if (type === 'module') item = (libRef.current?.modules || []).find((x) => x.id === id);
    else if (type === 'special' || type === 'position') item = id; // 特殊节点/POSITION 的 item 是字符串
    if (!item) return;
    clearTimeout(libTimerRef.current);
    libDragRef.current = {
      phase: 'pending', type, item,
      startX: t.clientX, startY: t.clientY,
      lastX: t.clientX, lastY: t.clientY,
      lastMoveAt: performance.now(), bornAt: performance.now(),
    };
    // 长按武装判定（可顺延）：到点复核"漂移小 + 最近确实没动"，慢速滚动会被正确拒绝
    const tryArm = () => {
      const st = libDragRef.current;
      if (!st || st.phase !== 'pending') return;
      const now = performance.now();
      const driftX = Math.abs(st.lastX - st.startX);
      const driftY = Math.abs(st.lastY - st.startY);
      const stillLongEnough = now - st.lastMoveAt >= LIB_STILL_MS;
      if (driftX > LIB_DRAG_SLOP_PX || driftY > LIB_DRAG_SLOP_PX || !stillLongEnough) {
        if (now - st.bornAt < LIB_ARM_MAX_WAIT_MS) {
          libTimerRef.current = setTimeout(tryArm, LIB_ARM_RECHECK_MS);
        } else {
          libDragRef.current = null; // 放弃武装，交还原生滚动（本手势不再有拖拽）
        }
        return;
      }
      st.phase = 'drag';
      navigator.vibrate?.(15); // iOS Safari 不支持 vibrate；iPhone 靠下方视觉反馈
      const label = typeof st.item === 'string' ? st.item : (st.item?.name || st.type);
      setLibArmedKey(`${st.type}:${typeof st.item === 'string' ? st.item : st.item?.id}`);
      setLibDragActive(true); // round49：补回 round47 丢失的调用——画布虚线放置提示恢复
      if (ghostRef.current && ghostLabelRef.current) {
        ghostLabelRef.current.textContent = label;
        ghostRef.current.style.display = 'block';
        ghostRef.current.style.left = `${st.startX - 50}px`;
        ghostRef.current.style.top = `${st.startY - 20}px`;
      }
    };
    libTimerRef.current = setTimeout(tryArm, LIB_LONG_PRESS_MS);
  }, []);

  // 面板级 touchmove（非 passive）：
  // drag 相位才 preventDefault；pending 相位只记账，≥8px 即承诺滚动并永久放手。
  const handleLibTouchMove = useCallback((e) => {
    const st = libDragRef.current;
    if (!st) return;
    const t = e.touches[0];
    if (st.phase === 'drag') {
      e.preventDefault();
      e.stopPropagation();
      if (ghostRef.current) {
        ghostRef.current.style.left = `${t.clientX - 50}px`;
        ghostRef.current.style.top = `${t.clientY - 20}px`;
      }
      return;
    }
    // pending：零拦截记账。任一轴累计 ≥LIB_SCROLL_COMMIT_PX → 判滚动意图，
    // 清掉一切拖拽状态，本手势剩余时间与原生 pan-y 完全无关。
    st.lastX = t.clientX; st.lastY = t.clientY;
    st.lastMoveAt = performance.now();
    const dx = Math.abs(t.clientX - st.startX);
    const dy = Math.abs(t.clientY - st.startY);
    if (dx >= LIB_SCROLL_COMMIT_PX || dy >= LIB_SCROLL_COMMIT_PX) {
      clearTimeout(libTimerRef.current);
      libDragRef.current = null;
    }
  }, []);

  const handleLibTouchCancel = useCallback((e) => {
    // 浏览器接管手势（原生滚动/系统语义），JS 事件流到此终止——全量复位
    clearTimeout(libTimerRef.current);
    if (ghostRef.current) ghostRef.current.style.display = 'none';
    setLibArmedKey(null);
    setLibDragActive(false);
    libDragRef.current = null;
  }, []);

  const handleLibTouchEnd = useCallback((e) => {
    clearTimeout(libTimerRef.current);
    setLibArmedKey(null); // 无论放置/取消，抓起态视觉必须回落
    setLibDragActive(false);
    if (ghostRef.current) ghostRef.current.style.display = 'none';
    const st = libDragRef.current;
    libDragRef.current = null;
    if (!st || st.phase !== 'drag') return;
    const t = e.changedTouches[0];
    // 判断落点是否在画布区域内
    const cvRect = cvRef.current?.getBoundingClientRect();
    if (!cvRect) return;
    if (t.clientX < cvRect.left || t.clientX > cvRect.right || t.clientY < cvRect.top || t.clientY > cvRect.bottom) {
      return;
    }
    // 转换为画布世界坐标
    const worldX = (t.clientX - cvRect.left - pan.x) / scale - 50;
    const worldY = (t.clientY - cvRect.top  - pan.y) / scale - 20;
    const { type, item } = st;
    if (type === 'action') onAdd(item, worldX, worldY);
    else if (type === 'module') onAddModule(item, worldX, worldY);
    else if (type === 'special') onAddSpecial(item, worldX, worldY);  // item 此时是字符串如 'OUT'
    else if (type === 'position') onAddPosition(worldX, worldY);       // position 不需要 item
  }, [pan, scale, cvRef, onAdd, onAddModule, onAddSpecial, onAddPosition]);

  // 当前选中实体
  const selNode = sel?.type === 'node' ? nodes.find((n) => n.id === sel.id) : null;
  const selEdge = sel?.type === 'edge' ? edges.find((e) => e.id === sel.id) : null;
  const selAction = selNode?.type === 'action' ? actionStore?.find((a) => a.id === selNode.actionId) : null;

  return (
    <div
      data-femo-theme={theme}
      style={{
        position: fixedMode ? 'fixed' : 'absolute',
        inset: 0,
        zIndex: zIndex,
        display: 'flex',
        flexDirection: 'column',
        background: T.bg,
        fontFamily: 'var(--femo-font-sans)',
        overflow: 'hidden',
      }}
    >
      <MobileGlobalStyle />

      {/* ── 标题栏 ── */}
      <MobileTitleBar
        projName={proj?.name}
        flowStatus={flowStatus}
        femoVisible={femoVisible}
        onBack={fixedMode ? onBack : undefined}
        onExpand={fixedMode ? undefined : onExpand}
        onToggleFemo={() => setFemoVisible((v) => !v)}
        onRun={onRun}
        onStop={onStop}
        onResume={onResume}
        hasActiveRunningNodes={hasActiveRunningNodes}
        onImport={onImport}
        onExport={onExport}
        exportBusy={exportBusy}
        // Module 子画布层级：非主流程时显示「‹ 模块名」返回键（此前手机端
        // 进入子画布后无任何返回入口，只能重载会话）。
        locationPath={locationPath}
        onNavigatePath={onNavigatePath}
      />

      {/* 导出保存回执（2026-09-11 手机端补齐）：锚在标题栏正下方右侧，与桌面
          工具栏同款（4s 自动消失，见 FemoWorAuto.showExportToast）。top 用与
          标题栏同源的 clamp（5vh，40~56 clamped），任意屏高都紧贴标题栏下沿；
          key=id 使连续两次导出重放浮现动画。 */}
      {exportToast !== null && (
        <div
          key={exportToast.id}
          style={{
            position: 'absolute',
            top: 'clamp(40px, 5vh, 56px)',
            right: 12,
            marginTop: 6,
            zIndex: 150,
            maxWidth: 'min(560px, calc(100% - 24px))',
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
            animation: 'dropHintIn 0.2s ease',
          }}
        >
          {exportToast.text}
        </div>
      )}

      {/* ── 画布 ── */}
      <div
        ref={cvRef}
        className="femo-canvas-zone"
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          backgroundImage: 'var(--femo-mobile-canvas-dots)',
          backgroundSize: '22px 22px',
          cursor: isPanning ? 'grabbing' : conn ? 'crosshair' : 'default',
          minHeight: 0,
        }}
        // Mouse events (桌面兼容)。触摸手势 round56 起由 useMobileCanvasGesture
        // 内部的原生监听接管（登记制 + identifier 锁定），不再走 React 合成事件。
        onMouseMove={onMM}
        onMouseUp={onMU}
        onMouseDown={onCanvasDown}
        onWheel={handleWheel}
        onMouseLeave={onMU}
        // Drag-drop
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
      >
        <div
          data-canvas-bg="true"
          style={{
            opacity: canvasOpacity,
            transition: 'opacity 0.2s ease',
            position: 'absolute',
            inset: 0,
          }}
        >
          <div
            ref={tfRef}
            data-canvas-bg="true"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              inset: 0,
            }}
          >
            {canvasContent}
          </div>
        </div>

{/* 空状态提示（zIndex 极低，永远不遮节点）*/}
        {nodes.filter((n) => n.type !== 'special').length === 0 && !conn && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--femo-mobile-border-light)', fontWeight: 600 }}>从仓库添加 Action</div>
            <div style={{ fontSize: 11, color: 'var(--femo-mobile-border)', marginTop: 5 }}>长按节点拖动 · 长按端口连线 · 双指缩放</div>
          </div>
        )}

        {/* round27：仓库拖拽激活中——画布浮现虚线可放置提示 + 顶部胶囊 */}
        {libDragActive && (
          <>
            <div style={{
              position: 'absolute',
              inset: 8,
              borderRadius: 'var(--femo-radius-lg)',
              border: 'var(--femo-border-w-selected) dashed var(--femo-primary-glow-x)',
              background: 'var(--femo-primary-soft-faint)',
              pointerEvents: 'none',
              zIndex: 150,
              animation: 'dropHintIn 0.22s ease-out',
            }} />
            <div style={{
              position: 'absolute',
              top: 18,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--femo-primary-overlay)',
              color: 'var(--femo-on-accent)',
              padding: '3px 11px',
              borderRadius: 'var(--femo-radius-md)',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.02em',
              pointerEvents: 'none',
              zIndex: 151,
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 14px var(--femo-primary-glow-strong)',
              animation: 'dropHintIn 0.25s ease-out',
            }}>
              松手放置到画布
            </div>
          </>
        )}

        {/* 长按就绪视觉反馈：在 dragReady 节点上方显示小环 */}
        {dragReady && (() => {
          const n = nodes.find(nd => nd.id === dragReady);
          if (!n) return null;
          const { w, h } = { w: 200, h: 80 }; // 估算节点中心，不引入 getNodeSize
          const cx = (n.x + w / 2) * scale + pan.x;
          const cy = (n.y + h / 2) * scale + pan.y;
          return (
            <div style={{
              position: 'absolute',
              left: cx - 28,
              top: cy - 28,
              width: 56,
              height: 56,
              borderRadius: 'var(--femo-radius-pill)',
              border: 'var(--femo-border-w-selected) solid var(--femo-primary-glow-x)',
              boxShadow: '0 0 12px 4px var(--femo-primary-glow)',
              pointerEvents: 'none',
              zIndex: 200,
              animation: 'pulse 0.6s ease-out',
            }} />
          );
        })()}

        {/* 缩放比例徽标（round56 加于右下角）2026-09-11 用户点名摘除：手机端画布
            不再显示 XX%——捏合缩放无需实时数字反馈（transform 照旧直写，手感不变）。
            连手势层的直写与 scaleBadgeRef 挂点一并拆除，勿再补回。 */}
      </div>

      {/* 拖拽幽灵预览（round27：弹出动画 + 光晕呼吸，明确"已激活"）——round47 改常驻+ref 直写 */}
      <div
        ref={ghostRef}
        style={{
          display: 'none',
          position: 'fixed',
          background: 'var(--femo-primary-overlay)',
          color: 'var(--femo-on-accent)',
          borderRadius: 'var(--femo-radius-md)',
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 700,
          pointerEvents: 'none',
          zIndex: 999,
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px var(--femo-primary-glow-strong)',
        }}
      >
        <span ref={ghostLabelRef} />
      </div>

      {/* ── 底部面板 ── */}
      <MobileBottomPanel
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        lib={lib}
        mode={mode}
        locationPath={locationPath}
        allNames={allNames}
        onNew={onNew}
        onAdd={onAdd}
        onAddModule={onAddModule}
        onAddSpecial={onAddSpecial}
        onAddPosition={onAddPosition}
        onEdit={onEdit}
        onEditModule={onEditModule}
        onDragStart={onDragStart}
        onPanelTouchStart={handlePanelTouchStart}
        onLibTouchMove={handleLibTouchMove}
        onLibTouchEnd={handleLibTouchEnd}
        onLibTouchCancel={handleLibTouchCancel}
        libArmedKey={libArmedKey}
        onSelectLib={(type, id) => {
          onSelectLib?.(type, id);
          setBottomTab('props');
        }}
        onNewModule={onNewModule}
        proj={proj}
        actorNames={actorNames}
        onProjChange={onProjChange}
        sel={sel}
        selNode={selNode}
        selEdge={selEdge}
        selAction={selAction}
        nodes={nodes}
        edges={edges}
        backEdges={backEdges}
        nodeStates={nodeStates}
        actionStore={actionStore}
        onDeleteNode={onDeleteNode}
        onDeleteEdge={onDeleteEdge}
        onCondChange={onCondChange}
        onEditAction={onEditAction}
        onEnterModuleNode={onEnterModuleNode}
        libSel={libSel}
        themeName={themeName}
        onCycleTheme={onCycleTheme}
        onOpenSoul={onOpenSoul}
        debugLog={debugLog}
        onClearDebug={onClearDebug}
        compilerLog={compilerLog}
        onClearCompiler={onClearCompiler}
        femogenLog={femogenLog}
        onClearFemogen={onClearFemogen}
        hostLog={hostLog}
        onClearHost={onClearHost}
        onCompileDebug={onCompileDebug}
        compilingDebug={compilingDebug}
        htmlDraggable={false}
      />

      {/* ── FEMO 预览面板 — 直接复用桌面原版，包裹在滑出容器里 ── */}
      {femoVisible && (
        <>
          <div
            onClick={() => setFemoVisible(false)}
            style={{ position: 'fixed', inset: 0, background: 'var(--femo-mask)', zIndex: 300 }}
          />
          <div style={{
            position: 'fixed', right: 0, top: 0, bottom: 0,
            width: '88vw', maxWidth: 460,
            background: 'var(--femo-mobile-bg-2)',
            borderLeft: `var(--femo-border-w) solid ${T.border}`,
            zIndex: 301,
            display: 'flex', flexDirection: 'column',
            animation: 'slideInFemo 0.22s cubic-bezier(0.4,0,0.2,1)',
            boxShadow: '-8px 0 32px var(--femo-mask)',
          }}>
            <FemoPreview
              value={femoText}
              onChange={onFemoChange}
              error={femoError}
              warnings={FEMOrnings}
              dirty={femoDirty}
              onApply={onApplyFemo}
              onRestore={onRestoreFemo}
              onGraphToFemo={onGraphToFemo}
            />
          </div>
        </>
      )}

{/* ── 气泡弹层 — 直接复用桌面原版 ── */}
      <BubbleOverlay
        bubbleOverlay={bubbleOverlay}
        nodes={nodes}
        nodeStates={nodeStates}
        humanWaits={humanWaits}
        actionStore={actionStore}
        onClose={onBubbleClose}
        submitHumanInput={submitHumanInput}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// 共享样式 token（模块内）
// ─────────────────────────────────────────────
const sectionLabel = {
  fontSize: 9.5,
  fontWeight: 800,
  color: T.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontFamily: 'var(--femo-font-sans)',
};

// 设置面板三键同构配方（2026-09-08 r2）：等宽 flex:1 均衡 + 32px 最小高度（对齐
// MobileIconBtn 芯片家族）+ 同 padding/字号/边框，仅图标与文字区分语义
// （FaPalette 主题 / FaUserPlus 新建SOUL / FaTerminal 调试）。overflow:hidden
// 配合文字 span 省略号，长主题名不撑破等宽布局；按压反馈走 femo-mob-setting-btn。
const mobSettingBtn = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '8px 6px',
  minHeight: 32,
  boxSizing: 'border-box',
  borderRadius: 'var(--femo-radius-md)',
  fontSize: 11.5,
  fontWeight: 600,
  fontFamily: 'var(--femo-font-sans)',
  cursor: 'pointer',
  border: 'var(--femo-border-w) solid var(--femo-border-strong)',
  background: 'var(--femo-bg)',
  color: 'var(--femo-text-2)',
  flex: 1,
  minWidth: 0,
  position: 'relative',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
};

// 三键文字 span：省略号兜底（minWidth:0 让 flex 子项可收缩）。
const mobSettingBtnText = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const fieldLabel = {
  fontSize: 10,
  fontWeight: 700,
  color: T.textSecondary,
  marginBottom: 4,
};

const mobInp = {
  width: '100%',
  padding: '6px 9px',
  borderRadius: 'var(--femo-radius-sm)',
  border: `var(--femo-border-w-strong) solid ${T.border}`,
  fontSize: 11.5,
  color: T.textPrimary,
  background: 'var(--femo-mobile-bg)',
  outline: 'none',
  fontFamily: 'var(--femo-font-sans)',
  transition: 'border-color 0.15s',
  boxSizing: 'border-box',
  touchAction: 'auto',
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

const mobBtnP = {
  padding: '6px 14px',
  borderRadius: 'var(--femo-radius-sm)',
  background: 'var(--femo-btn-primary)',
  color: 'var(--femo-on-accent)',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 700,
  fontFamily: 'var(--femo-font-sans)',
};

const mobBtnS = {
  padding: '5px 12px',
  borderRadius: 'var(--femo-radius-sm)',
  background: 'transparent',
  color: T.textSecondary,
  border: `var(--femo-border-w-strong) solid ${T.border}`,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 600,
  fontFamily: 'var(--femo-font-sans)',
};

// FEMO 面板头排统一芯片配方（2026-09-07 与桌面端 femoPreview 同构）：浅色
// 同系底 + 1px 同色细边，仅用颜色区分语义。可点击态用主题强调色（灰底像
// 禁用）；不再混用 mobBtnS 粗描边与 mobBtnP 无边填充。
const mobChip = (color, active = false) => ({
  padding: '4px 10px',
  borderRadius: 'var(--femo-radius-sm)',
  background: `color-mix(in srgb, ${color} ${active ? 15 : 10}%, transparent)`,
  border: `1px solid color-mix(in srgb, ${color} ${active ? 45 : 35}%, transparent)`,
  color,
  cursor: 'pointer',
  fontSize: 10,
  fontWeight: 700,
  fontFamily: 'var(--femo-font-sans)',
  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
});

const mobBtnDanger = {
  padding: '6px 14px',
  borderRadius: 'var(--femo-radius-sm)',
  background: 'transparent',
  color: T.danger,
  border: `var(--femo-border-w-strong) solid ${T.danger}44`,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 700,
  fontFamily: 'var(--femo-font-sans)',
};

// ─────────────────────────────────────────────
// Hook：检测是否为手机端
// ─────────────────────────────────────────────
function useMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return isMobile;
}

export {
  MobileLayout,
  MobileFemoPanel,
  MobileBubbleOverlay,
  MobileHumanInput,
  MobileTitleBar,
  MobileBottomPanel,
  useMobileCanvasGesture,
  useMobile,
};
