// ═══════════════════════════════════════════════════════════════
// ═══ libPanel.jsx ═══
// ═══════════════════════════════════════════════════════════════
import React, { useState } from 'react';
import { TYPES, ti, inp, btnP, btnS, NW, NH, MW, MH } from './common';


function LibPanel({
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
  onSelectLib,
  onNewModule,
  // round49：手机端触摸改为面板级统一监听（mobileView.jsx），卡片只挂 data-femo-lib-drag 标记
  // 供面板 touchstart 用 closest() 找"拖哪个"——落点不再参与手势裁决，卡片自身零触摸监听。
  armedKey = null, // round27：手机端长按激活抓起态（"type:id"）；桌面端不传=null 永不命中
  htmlDraggable = true, // round45：手机端传 false——draggable 卡片在触摸设备上会阻止原生滚动
  cardLayout = 'list', // round51：'list'=全宽单列（桌面默认）；'grid3'=Actions/特殊节点一行三卡（仅手机传）
}) {
  // round27：长按激活抓起态——被抓住的卡片亮主色边框+混底+微放大+光晕，平滑亮起/回落
  const grabTransition =
    'transform 0.15s cubic-bezier(0.34,1.56,0.64,1), border-color 0.15s, background-color 0.15s, box-shadow 0.15s';
  const isGrabbed = (type, item) =>
    armedKey === `${type}:${typeof item === 'string' ? item : item?.id}`;
  const grabStyle = (grabbed) =>
    grabbed
      ? {
          border: 'var(--femo-node-border-w) solid var(--femo-primary)',
          background: 'var(--femo-primary-soft-faint)',
          transform: 'scale(1.04)',
          boxShadow: '0 6px 18px var(--femo-primary-glow-strong)',
        }
      : {};
  // round51：grid3 模式常量——行容器 flex 换行 + 单卡占 1/3 宽（扣除两个 7px 沟槽）。
  // box-sizing:border-box 必须显式声明：否则 padding+边框加在 1/3 之外，第三张卡挤不下掉行。
  const GRID_ROW = { display: 'flex', flexWrap: 'wrap', gap: 7 };
  // round51b：特殊节点网格与下方 POSITION 卡之间原本靠卡片 marginBottom 撑开的 7px，
  // 容器化后卡片 margin 清零会断——容器自己补回。
  const SPECIAL_GRID_ROW = { ...GRID_ROW, marginBottom: 7 };
  const gridItemStyle =
    cardLayout === 'grid3'
      ? { flex: '0 0 calc((100% - 14px) / 3)', marginBottom: 0, boxSizing: 'border-box', minWidth: 0 }
      : null;
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
          { t: 'FOR', lbl: 'FOR', c: 'var(--femo-primary-strong)', bg: 'var(--femo-primary-soft)' },
          { t: 'PAR', lbl: 'PAR', c: 'var(--femo-special-par)', bg: 'var(--femo-special-par-bg)' },
          { t: 'END', lbl: 'END', c: 'var(--femo-danger)', bg: 'var(--femo-danger-soft)' },
        ]
      : [
          { t: 'FOR', lbl: 'FOR', c: 'var(--femo-primary-strong)', bg: 'var(--femo-primary-soft)' },
          { t: 'PAR', lbl: 'PAR', c: 'var(--femo-special-par)', bg: 'var(--femo-special-par-bg)' },
          { t: 'BREAK', lbl: 'BREAK', c: 'var(--femo-warning)', bg: 'var(--femo-warning-soft)' },
          { t: 'OUT', lbl: 'OUT', c: 'var(--femo-danger)', bg: 'var(--femo-danger-soft)' },
        ];

  return (
    <div>
      {/* Actions section */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 11,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: 'var(--femo-neutral)',
            textTransform: 'uppercase',
            letterSpacing: '0.09em',
          }}
        >
          Actions
        </span>
        <button
          onClick={onNew}
          style={{
            padding: '4px 11px',
            fontSize: 11,
            background: 'var(--femo-btn-primary)',
            color: 'var(--femo-on-accent)',
            border: 'none',
            borderRadius: 'var(--femo-radius-md)',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          + 新建
        </button>
      </div>
      {displayActions.length === 0 ? (
        <div
          style={{ textAlign: 'center', padding: '18px 0', color: 'var(--femo-text-4-weak)' }}
        >
          <div style={{ fontSize: 22, marginBottom: 6, opacity: 0.5 }}>*</div>
          <div style={{ fontSize: 11.5 }}>
            {mode === 'module' ? '无可用 Actions' : '还没有 Action'}
          </div>
        </div>
      ) : (
        <div style={cardLayout === 'grid3' ? GRID_ROW : undefined}>
        {displayActions.map((a) => {
          const { c } = ti(a.executorType);
          const bk = ['ai', 'human', 'mind', 'func', 'assign', 'notice'].includes(a.executorType) ? a.executorType : 'ai';
          return (
            <div
              key={a.id}
              draggable={htmlDraggable}
              onDragStart={(e) => onDragStart(e, 'action', a.id)}
              onClick={() => onSelectLib && onSelectLib('action', a.id)}
              onDoubleClick={() => onEdit && onEdit(a)}
              data-femo-lib-drag={`action:${a.id}`}
              style={{
                background: 'var(--femo-node-bg)',
                borderRadius: 'var(--femo-radius-md)',
                border: `var(--femo-node-border-w) solid var(--femo-node-border)`,
                padding: '8px 10px',
                marginBottom: 7,
                cursor: 'grab',
                ...(gridItemStyle || {}),
                ...grabStyle(isGrabbed('action', a)),
                transition: grabTransition,
              }}
            >
              {/* 行1：类型芯片 + 名称 + 编辑（与画布节点行1同构） */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    background: `var(--femo-badge-bg-${bk})`,
                    color: `var(--femo-badge-fg-${bk})`,
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
                  {a.executorType || 'ai'}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: 'var(--femo-text-1)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {a.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(a);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--femo-neutral)',
                    padding: '1px 3px',
                    flexShrink: 0,
                  }}
                >
                  E
                </button>
              </div>
              {/* 行2：执行者 + 添加按钮 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--femo-neutral)',
                    fontFamily: 'var(--femo-font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {a.executorActor || ''}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd(a);
                  }}
                  style={{
                    padding: '2px 9px',
                    fontSize: 10,
                    background: 'var(--femo-btn-primary)',
                    color: 'var(--femo-on-accent)',
                    border: 'none',
                    borderRadius: 'var(--femo-radius-md)',
                    cursor: 'pointer',
                    fontWeight: 700,
                    flexShrink: 0,
                    fontFamily: 'var(--femo-font-sans)',
                  }}
                >
                  + 画布
                </button>
              </div>
            </div>
          );
        })}
        </div>
      )}
      {/* New Module creation */}
      <div style={{ marginTop: 14, marginBottom: 10 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: 'var(--femo-neutral)',
            textTransform: 'uppercase',
            letterSpacing: '0.09em',
            marginBottom: 6,
          }}
        >
          新建模块
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <input
            placeholder="模块名"
            style={{
              width: '100%',
              padding: '5px 8px',
              borderRadius: 'var(--femo-radius-md)',
              border: 'var(--femo-border-w-strong) solid var(--femo-border-strong)',
              fontSize: 11.5,
              color: 'var(--femo-text-1)',
              background: 'var(--femo-bg)',
              outline: 'none',
              fontFamily: 'var(--femo-font-sans)',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              flex: 1,
            }}
          />
          <button
            onClick={(e) => {
              const input = e.target.parentNode.querySelector('input');
              const name = input.value.trim();
if (name && (!allNames || !allNames.has || !allNames.has(name))) {
                onNewModule(name);
                input.value = '';
              }
            }}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              background: 'var(--femo-btn-primary)',
              color: 'var(--femo-on-accent)',
              border: 'none',
              borderRadius: 'var(--femo-radius-md)',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            创建
          </button>
        </div>
      </div>
      {/* Modules section */}
      {displayModules.length > 0 && (
        <>
          <div
            style={{
              marginTop: 16,
              marginBottom: 11,
              fontSize: 10,
              fontWeight: 800,
              color: 'var(--femo-neutral)',
              textTransform: 'uppercase',
              letterSpacing: '0.09em',
            }}
          >
            Modules
          </div>
          {displayModules.map((m) => (
            <div
              key={m.id}
              draggable={htmlDraggable}
              onDragStart={(e) => onDragStart(e, 'module', m.id)}
              onClick={() => onSelectLib && onSelectLib('module', m.id)}
              onDoubleClick={() => onEditModule && onEditModule(m)}
              data-femo-lib-drag={`module:${m.id}`}
              style={{
                background: 'var(--femo-node-bg)',
                borderRadius: 'var(--femo-radius-md)',
                border: `var(--femo-node-border-w) solid var(--femo-node-border)`,
                padding: '9px 11px',
                marginBottom: 7,
                cursor: 'grab',
                ...grabStyle(isGrabbed('module', m)),
                transition: grabTransition,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span
                  style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--femo-text-1)' }}
                >
                  &{m.name}
                </span>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditModule(m);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--femo-neutral)',
                      padding: '2px 6px',
                    }}
                  >
                    编辑
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddModule(m);
                    }}
                    style={{
                      padding: '2px 9px',
                      fontSize: 10,
                      background: 'var(--femo-btn-primary)',
                      color: 'var(--femo-on-accent)',
                      border: 'none',
                      borderRadius: 'var(--femo-radius-md)',
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    + 画布
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      {/* Special nodes section */}
      <div
        style={{
          marginTop: 16,
          marginBottom: 11,
          fontSize: 10,
          fontWeight: 800,
          color: 'var(--femo-neutral)',
          textTransform: 'uppercase',
          letterSpacing: '0.09em',
        }}
      >
        特殊节点
      </div>
      <div style={cardLayout === 'grid3' ? SPECIAL_GRID_ROW : undefined}>
      {specialNodes.map((s) => (
          <div
            key={s.t}
            draggable={htmlDraggable}
            onDragStart={(e) => onDragStart(e, 'special', s.t)}
            data-femo-lib-drag={`special:${s.t}`}
            style={{
            background: 'var(--femo-node-bg)',
            borderRadius: 'var(--femo-radius-md)',
            border: `var(--femo-node-border-w) solid color-mix(in srgb, ${s.c} 50%, var(--femo-node-bg))`,
            padding: cardLayout === 'grid3' ? '7px 8px' : '9px 11px',
            marginBottom: 7,
            cursor: 'grab',
            ...(gridItemStyle || {}),
            ...grabStyle(isGrabbed('special', s.t)),
            transition: grabTransition,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: 'var(--femo-text-1)',
                fontFamily: 'var(--femo-font-mono)',
              }}
            >
              [{s.lbl}]
            </span>
            <button
              onClick={() => onAddSpecial(s.t)}
              style={{
                padding: '2px 9px',
                fontSize: 10,
                background: 'var(--femo-btn-primary)',
                color: 'var(--femo-on-accent)',
                border: 'none',
                borderRadius: 'var(--femo-radius-md)',
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              + 画布
            </button>
          </div>
        </div>
        ))}
      </div>
      {/* POSITION node */}
      <div
        draggable={htmlDraggable}
        onDragStart={(e) => onDragStart(e, 'position', 'POSITION')}
        data-femo-lib-drag="position:POSITION"
        style={{
          background: 'var(--femo-bg)',
          borderRadius: 'var(--femo-radius-md)',
          border: 'var(--femo-node-border-w) solid var(--femo-border)',
          padding: '9px 11px',
          marginBottom: 7,
          cursor: 'grab',
          ...grabStyle(isGrabbed('position', 'POSITION')),
          transition: grabTransition,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--femo-text-1)',
              fontFamily: 'var(--femo-font-mono)',
            }}
          >
            POSITION
          </span>
          <button
            onClick={onAddPosition}
            style={{
              padding: '2px 9px',
              fontSize: 10,
              background: 'var(--femo-btn-primary)',
              color: 'var(--femo-on-accent)',
              border: 'none',
              borderRadius: 'var(--femo-radius-md)',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            + 画布
          </button>
        </div>
        <div style={{ fontSize: 10, color: 'var(--femo-neutral)', marginTop: 3 }}>
          空节点，仅占位
        </div>
      </div>
    </div>
  );
}

export { LibPanel };
