// ═══════════════════════════════════════════════════════════════
// ═══ canvasNodes.jsx ═══
// ═══════════════════════════════════════════════════════════════

import React from 'react';
import { PortCircle, TYPES, SPECIAL_COLORS, NW, NH, MW, MH, SPW, SPH, PSW, PSH, ti, SINK_ONLY, getNodeSize } from './common';


function ActionNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
  onDbl,
  onBubbleClick,
  nodeState,
  isActive,
  errorNodeIds,
}) {
  const isMod = node.type === 'module';
  const w = isMod ? MW : NW,
    h = isMod ? MH : NH;
  const { c } = isMod
    ? { c: 'var(--femo-tag-bg)', bg: 'var(--femo-bg-2)' }
    : ti(node.action?.executorType);
  // 左上角类型徽章 token key（module 用专组；executorType 不在 TYPES 里时回退 ai，与 ti 回退一致）
  const badgeKey = isMod
    ? 'module'
    : TYPES.some((t) => t.t === node.action?.executorType)
      ? node.action.executorType
      : 'ai';

  // 是否显示气泡：有 nodeState（运行中或已完成）时显示
  //console.log(
  //  `[ActionNodeView] node.id="${node.id}" node.label="${node.label}" node.type="${node.type}" nodeState=`,
  //  nodeState
  //);
  const hasState = !!nodeState?.status;
  const isStreaming = nodeState?.status === 'ai_streaming';
  const isHumanWait = nodeState?.status === 'human_wait';
  const isDone = ['ai_done', 'human_done', 'done'].includes(nodeState?.status);

  const ports = {
    top: { x: w / 2, y: 0 },
    bottom: { x: w / 2, y: h },
    left: { x: 0, y: h / 2 },
    right: { x: w, y: h / 2 },
  };

  // 呼吸灯动画样式
  const isErrorExplicit = errorNodeIds?.has(node.id) ?? false;
  const isError = nodeState?.status === 'error' || isErrorExplicit;
  const glowStyle = (isActive || isError)
    ? {
        animation: isError
          ? 'nodeGlowError 1.5s ease-in-out infinite'
          : 'nodeGlow 1.5s ease-in-out infinite',
      }
    : {};

  return (
<div
      data-node-id={node.id}
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      onDoubleClick={onDbl}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: 'var(--femo-node-bg)',
        borderRadius: 'var(--femo-radius-lg)',
        border: `var(--femo-node-border-w) solid ${sel ? c : 'var(--femo-node-border)'}`,
        boxShadow: sel
          ? `0 0 0 3px color-mix(in srgb, ${c} 13%, transparent), var(--femo-node-shadow-sel)`
          : 'var(--femo-node-shadow-rest)',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        fontFamily: 'var(--femo-font-sans)',
        ...glowStyle,
      }}
    >
      <div style={{ padding: '10px 12px 9px' }}>
        {/* 行1：类型芯片 + 执行者（执行者名字一般不长，放得下） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, minWidth: 0, minHeight: 15 }}>
          <span
            style={{
              background: `var(--femo-badge-bg-${badgeKey})`,
              color: `var(--femo-badge-fg-${badgeKey})`,
              borderRadius: 'var(--femo-radius-xs)',
              padding: '1px 5px',
              fontSize: 8.5,
              fontWeight: 800,
              letterSpacing: '0.04em',
              fontFamily: 'var(--femo-font-mono)',
              lineHeight: 1.4,
              flexShrink: 0,
            }}
          >
            {isMod ? 'module' : node.action?.executorType || 'ai'}
          </span>
          {!isMod && node.action?.executorActor ? (
            <span
              style={{
                fontSize: 10,
                color: 'var(--femo-neutral)',
                fontFamily: 'var(--femo-font-mono)',
                marginLeft: 'auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {node.action.executorActor}
            </span>
          ) : null}
        </div>
        {/* 行2：action 名独占整行（节点 label 与 action 名同步，显示 action 名即节点名） */}
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: 'var(--femo-text-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isMod ? `&${node.modRef || 'Module'}` : node.action?.name || '未命名'}
        </div>
      </div>







      {/* 小气泡 - 有状态时自动显示，运行完不消失（data-bubble-node：手机端触摸仲裁识别用） */}
      {hasState && node.type === 'action' && (
        <div
          data-bubble-node={node.id}
          onClick={(e) => {
            e.stopPropagation();
            onBubbleClick && onBubbleClick(node.id);
          }}
          style={{
            position: 'absolute',
            top: -28,
            right: -8,
            maxWidth: 180,
            minWidth: 32,
            background: isStreaming ? 'var(--femo-primary-soft-2)' : isHumanWait ? 'var(--femo-warning-soft)' : 'var(--femo-success-soft)',
            borderRadius: 'var(--femo-radius-bubble)',
            border: `var(--femo-border-w-strong) solid ${isStreaming ? c : isHumanWait ? 'var(--femo-warning)' : 'var(--femo-success)'}`,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            zIndex: 5,
            boxShadow: '0 2px 8px var(--femo-shadow-sm)',
            padding: '3px 8px',
            overflow: 'hidden',
            transition: 'all 0.2s ease',
          }}
        >
          {isStreaming ? (
            <span
              style={{
                fontSize: 10,
                color: 'var(--femo-text-1)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
                lineHeight: '14px',
              }}
            >
              {nodeState.streamingText?.slice(-30) || '...'}
              <span style={{ animation: 'blink 0.7s infinite' }}>|</span>
            </span>
          ) : isHumanWait ? (
            <span style={{ fontSize: 10, color: 'var(--femo-warning)', fontWeight: 600, whiteSpace: 'nowrap' }}>
              ⏳ 等待输入
            </span>
          ) : isDone ? (
            <span
              style={{
                fontSize: 10,
                color: 'var(--femo-success-text)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 160,
              }}
            >
              {typeof nodeState.output === 'string'
                ? nodeState.output.length > 20
                  ? nodeState.output.slice(0, 20) + '...'
                  : nodeState.output
                : '✓ 完成'}
            </span>
          ) : (
            <span style={{ fontSize: 10, color: c, fontWeight: 600 }}>运行中...</span>
          )}
        </div>
      )}









      {/* 4 Ports */}
      {sel && (
        <>
          <PortCircle
            x={ports.top.x}
            y={ports.top.y}
            color={c}
            nodeId={node.id} portDir="top"
            portX={node.x + w/2} portY={node.y}
            onMouseDown={(e) => onPortDown(e, 'top', node.x + w/2, node.y)}
            onMouseUp={(e) => onPortUp(e, 'top', node.x + w/2, node.y)}
          />
          <PortCircle
            x={ports.bottom.x}
            y={ports.bottom.y}
            color={c}
            nodeId={node.id} portDir="bottom"
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={ports.left.x}
            y={ports.left.y}
            color={c}
            nodeId={node.id} portDir="left"
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={ports.right.x}
            y={ports.right.y}
            color={c}
            nodeId={node.id} portDir="right"
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}


function PositionNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
}) {
  const w = PSW,
    h = PSH;
  const c = 'var(--femo-text-2)',
    bg = 'var(--femo-bg)';
  const border = sel ? c : 'var(--femo-tag-bg)';

  const ports = {
    top: { x: w / 2, y: 0 },
    bottom: { x: w / 2, y: h },
    left: { x: 0, y: h / 2 },
    right: { x: w, y: h / 2 },
  };

  return (
    <div
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: bg,
        borderRadius: 'var(--femo-radius-xl)',
        border: `var(--femo-border-w-selected) solid ${border}`,
        boxShadow: sel
          ? `0 0 0 3px color-mix(in srgb, ${c} 13%, transparent), var(--femo-node-shadow-sel-sm)`
          : 'var(--femo-node-shadow-rest-sm)',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--femo-font-mono)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: c,
          letterSpacing: '0.06em',
        }}
      >
        {node.label.replace(/[\[\]]/g, '')}
      </span>

      {sel && (
        <>
          <PortCircle
            x={ports.top.x}
            y={ports.top.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'top')}
            onMouseUp={(e) => onPortUp(e, 'top')}
          />
          <PortCircle
            x={ports.bottom.x}
            y={ports.bottom.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={ports.left.x}
            y={ports.left.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={ports.right.x}
            y={ports.right.y}
            color={c}
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}


function SpecialNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
  isActive = false,
}) {
  const sc = SPECIAL_COLORS[node.specialType] || SPECIAL_COLORS.START;
  const size = getNodeSize(node);
  const w = size.w,
    h = size.h;
  const border = sc.c; // round21：特殊节点边框常显类型色（未选中细一号，选中加粗+光环）
  // round22：未选中边框与 node-bg 各半混合——灰度对齐金边框档位，色相保留；选中恢复鲜亮原色
  const borderDim = `color-mix(in srgb, ${sc.c} 50%, var(--femo-node-border-mix-base))`;
  const isSink = SINK_ONLY.has(node.specialType);

  const ports = {
    top: { x: w / 2, y: 0 },
    bottom: { x: w / 2, y: h },
    left: { x: 0, y: h / 2 },
    right: { x: w, y: h / 2 },
  };

  return (
    <div
      data-node-id={node.id}
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: sc.bg,
        borderRadius: 'var(--femo-radius-xl)',
        border: sel
          ? `var(--femo-border-w-selected) solid ${border}`
          : `var(--femo-border-w) solid ${borderDim}`,
        boxShadow: isActive
          ? `0 0 12px 4px ${sc.c}66, 0 0 24px 8px ${sc.c}33`
          : sel
            ? `0 0 0 3px color-mix(in srgb, ${sc.c} 13%, transparent), var(--femo-node-shadow-sel-sm)`
            : 'var(--femo-node-shadow-rest-sm)',
        animation: isActive ? 'nodeGlow 1.5s ease-in-out infinite' : 'none',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--femo-font-mono)',
      }}
    >
      <span
        className="femo-special-label"
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: sc.c,
          letterSpacing: '0.06em',
        }}
      >
        {node.specialType}
      </span>

      {sel && !isSink && (
        <>
          <PortCircle
            x={ports.top.x} y={ports.top.y} color={sc.c}
            nodeId={node.id} portDir="top"
            onMouseDown={(e) => onPortDown(e, 'top')}
            onMouseUp={(e) => onPortUp(e, 'top')}
          />
          <PortCircle
            x={ports.bottom.x} y={ports.bottom.y} color={sc.c}
            nodeId={node.id} portDir="bottom"
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={ports.left.x} y={ports.left.y} color={sc.c}
            nodeId={node.id} portDir="left"
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={ports.right.x} y={ports.right.y} color={sc.c}
            nodeId={node.id} portDir="right"
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}



function ForOutNodeView({ node, sel, onBodyMouseUp, onBubbleClick, onPortDown, onPortUp, forSpecialType = 'FOR' }) {
  const sc = SPECIAL_COLORS[forSpecialType] || SPECIAL_COLORS.FOR;
  const w = 22, h = 22;
  const centerX = node.x + w / 2;
  const centerY = node.y + h / 2;

  const handleMouseDown = (e) => {
    if (onPortDown) {
      onPortDown(e, 'center', centerX, centerY);
    }
  };

  const handleMouseUp = (e) => {
    if (onPortUp) {
      onPortUp(e, 'center', centerX, centerY);
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    onBubbleClick && onBubbleClick(node.id);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        borderRadius: 'var(--femo-radius-pill)',
        background: sc.bg,
        border: `${sel ? 2.5 : 1.5}px solid ${sc.c}`,  // 👈 只有选中才变粗
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 800,
        color: sc.c,
        fontFamily: 'var(--femo-font-mono)',
        cursor: sel ? 'grabbing' : 'crosshair',
        userSelect: 'none',
        zIndex: 23,
        boxShadow: sel ? `0 0 0 3px ${sc.c}44, 0 0 12px ${sc.c}55` : 'none',
        transition: 'border-width 0.12s, box-shadow 0.12s',
      }}
    >
      <span>出</span>
    </div>
  );
}


function ParOutNodeView({
  node,
  sel,
  onBody,
  onPortDown,
  onPortUp,
  onBodyMouseUp,
}) {
  const sc = SPECIAL_COLORS['PAR'] || SPECIAL_COLORS.FOR;
  const size = getNodeSize(node);
  const w = size.w, h = size.h;
  const border = sc.c; // round41：补齐 PAR_OUT 彩边（与 START/FOR/PAR 同款常显类型色）

  const rightPort = { x: w, y: h / 2 };

  return (
    <div
      onMouseDown={onBody}
      onMouseUp={onBodyMouseUp}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        background: sc.bg,
        borderRadius: 'var(--femo-radius-xl)',
        border: `var(--femo-border-w) solid ${border}`,
        boxShadow: sel
          ? `0 0 0 3px color-mix(in srgb, ${sc.c} 13%, transparent), var(--femo-node-shadow-sel-sm)`
          : 'var(--femo-node-shadow-rest-sm)',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: sel ? 20 : 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--femo-font-mono)',
      }}
    >
      <span
        className="femo-special-label"
        style={{
          fontSize: 11,
          fontWeight: 800,
          color: sc.c,
          letterSpacing: '0.06em',
        }}
      >
        PAR_OUT
      </span>

      {sel && (
        <>
          <PortCircle
            x={w / 2}
            y={0}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'top')}
            onMouseUp={(e) => onPortUp(e, 'top')}
          />
          <PortCircle
            x={w / 2}
            y={h}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'bottom')}
            onMouseUp={(e) => onPortUp(e, 'bottom')}
          />
          <PortCircle
            x={0}
            y={h / 2}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'left')}
            onMouseUp={(e) => onPortUp(e, 'left')}
          />
          <PortCircle
            x={w}
            y={h / 2}
            color={sc.c}
            onMouseDown={(e) => onPortDown(e, 'right')}
            onMouseUp={(e) => onPortUp(e, 'right')}
          />
        </>
      )}
    </div>
  );
}
export { ActionNodeView, PositionNodeView, SpecialNodeView, ForOutNodeView, ParOutNodeView };
