// ═══════════════════════
// ═══ actionModal.jsx ═══
// ═══════════════════════
import React, { useState, useEffect } from 'react';
import { TYPES, ti, Field, inp, btnP, btnS, aid } from './common';

// 执行者类型选择器展示顺序（2026-09-07）：mind 置顶，其余维持 TYPES 原序。
// 不动 common.TYPES 本体——ti() 的未知类型兜底取 TYPES[0]（ai），全局重排
// 会把兜底语义改成 mind。
const TYPE_DISPLAY_ORDER = ['mind', 'ai', 'human', 'func', 'assign', 'notice'];
const orderedTypes = (types) =>
  TYPE_DISPLAY_ORDER.map((t) => types.find((x) => x.t === t)).filter(Boolean);

// ═══ ACTION MODAL ═══
function ActionModal({
  init,
  existingNames,
  onSave,
  onClose,
  isModuleInternal,
}) {
  const blank = {
    name: '',
    executorType: 'ai',
    executorActor: '',
    prompt: '',
    showprompt: '',
    scope: '',
    outVars: '',
    inMappings: '',
    resolve: '',
    resolveArgs: '',
    maxRetries: 0,
    fallback: '',
    interrupt: '',
    memory: '',
    context: '',
  };
  const [f, setF] = useState(init || blank);
  const [nameErr, setNameErr] = useState('');
  const u = (x) => setF((p) => ({ ...p, ...x }));
  const type = ti(f.executorType);

  function handleNameChange(val) {
    u({ name: val });
    if (
      val.trim() &&
      existingNames?.includes(val.trim()) &&
      val.trim() !== init?.name
    ) {
      setNameErr(
        `名称 "${val.trim()}" 已被 action/module/actor 使用，请换一个`
      );
    } else {
      setNameErr('');
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--femo-mask-blue)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        style={{
          background: 'var(--femo-surface)',
          borderRadius: 'var(--femo-radius-xl)',
          width: 510,
          maxHeight: '88vh',
          overflow: 'auto',
          boxShadow: '0 32px 80px var(--femo-shadow-lg)',
          fontFamily: 'var(--femo-font-sans)',
        }}
      >
        <div
          style={{
            padding: '18px 22px 14px',
            borderBottom: 'var(--femo-border-w) solid var(--femo-border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            position: 'sticky',
            top: 0,
            background: 'var(--femo-surface)',
            zIndex: 1,
          }}
        >
          <div>
            <div style={{ fontWeight: 800, fontSize: 15.5, color: 'var(--femo-text-1)' }}>
              {init ? '编辑 Action' : '新建 Action'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--femo-text-4)', marginTop: 1 }}>
              定义后将出现在组件库中，可拖至画布
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 22,
              cursor: 'pointer',
              color: 'var(--femo-text-4)',
              lineHeight: 1,
              padding: 4,
            }}
          >
            x
          </button>
        </div>
        <div style={{ padding: '18px 22px 22px' }}>
          <Field label="Action 名称 *">
            <input
              value={f.name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="wolf_kill · speak · vote · resolve_night"
              style={{ ...inp, borderColor: nameErr ? 'var(--femo-danger)' : undefined }}
              autoFocus
            />
            {nameErr && (
              <div style={{ fontSize: 10.5, color: 'var(--femo-danger)', marginTop: 4 }}>
                {nameErr}
              </div>
            )}
          </Field>
          <Field label="执行者类型 *">
            <div style={{ display: 'flex', gap: 7 }}>
              {orderedTypes(TYPES).map((tp) => (
                <button
                  key={tp.t}
                  onClick={() => u({ executorType: tp.t })}
                  style={{
                    flex: 1,
                    padding: '8px 2px',
                    borderRadius: 'var(--femo-radius-md)',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 800,
                    fontFamily: 'var(--femo-font-mono)',
                    border: `var(--femo-border-w-selected) solid ${
                      f.executorType === tp.t ? tp.c : 'var(--femo-border-strong)'
                    }`,
                    background: f.executorType === tp.t ? tp.bg : 'var(--femo-surface)',
                    color: f.executorType === tp.t ? tp.c : 'var(--femo-text-4)',
                    transition: 'all 0.12s',
                  }}
                >
                  {tp.lbl}
                </button>
              ))}
            </div>
          </Field>
          {f.executorType !== 'notice' && (
            <Field>
              <input
                value={f.executorActor}
                onChange={(e) => {
                  let v = e.target.value.trim();
                  // func 和 assign 的 executorActor 是函数路径或变量名，不自动加 @
                  if (v && !v.startsWith('@') && f.executorType !== 'func' && f.executorType !== 'assign')
                    v = '@' + v;
                  u({ executorActor: v });
                }}
                placeholder={
                  f.executorType === 'func'
                    ? 'werewolf_utils.resolve_night'
                    : '@wolf'
                }
                style={{
                  ...inp,
                  fontFamily:
                    f.executorType === 'func'
                      ? 'JetBrains Mono, monospace'
                      : 'DM Sans, sans-serif',
                  fontSize: f.executorType === 'func' ? 12 : 12.5,
                }}
              />
            </Field>
          )}

          {(f.executorType === 'ai' || f.executorType === 'human' || f.executorType === 'mind' || f.executorType === 'notice') && (
            <Field label="Prompt" hint={f.executorType === 'notice' ? '注入的公告文本，支持 {变量} 插值，scope 内角色将读到' : '支持 {变量} 插值，AI 需输出 <<KEY: value>>'}>
              <textarea
                value={f.prompt}
                onChange={(e) => u({ prompt: e.target.value })}
                rows={4}
                placeholder={
                  f.executorType === 'notice'
                    ? '【广播】今夜暴雨，公园内的玩家请全部回家。\n当前存活玩家：{alive}'
                    : '夜晚降临。你是狼人，你的队友是 {wolves}。\n存活玩家：{alive}\n请和队友讨论今晚杀谁。\n最后输出：<<KILL: @目标名字>>'
                }
                style={{ ...inp, resize: 'vertical', lineHeight: 1.65 }}
              />
            </Field>
          )}
          <Field label="Show Prompt" hint="在上下文中会显示的提示，它组成上下文叙事的一部分">
            <textarea
              value={f.showprompt || ''}
              onChange={(e) => u({ showprompt: e.target.value })}
              rows={3}
              placeholder="例如：请等待其他玩家操作..."
              style={{ ...inp, resize: 'vertical', lineHeight: 1.65 }}
            />
          </Field>
          {f.executorType === 'func' && (
            <Field label="in 参数映射" hint="每行：param = var">
              <textarea
                value={f.inMappings}
                onChange={(e) => u({ inMappings: e.target.value })}
                rows={3}
                placeholder={
                  'target_name = seer_check_target\nsous_dict = souls\nalive_players = alive'
                }
                style={{
                  ...inp,
                  resize: 'vertical',
                  fontFamily: 'var(--femo-font-mono)',
                  fontSize: 11.5,
                  lineHeight: 1.7,
                }}
              />
            </Field>
          )}
          <Field label="Scope" hint="逗号分隔，谁能看到这次对话">
            <input
              value={f.scope}
              onChange={(e) => u({ scope: e.target.value })}
              placeholder="@hostgod, @wolf, @seer"
              style={inp}
            />
          </Field>
          <Field label="in 参数映射" hint="每行：param = var">
            <textarea
              value={f.inMappings}
              onChange={(e) => u({ inMappings: e.target.value })}
              rows={3}
              placeholder={'target_name = seer_check_target\nsous_dict = souls\nalive_players = alive'}
              style={{
                ...inp,
                resize: 'vertical',
                fontFamily: 'var(--femo-font-mono)',
                fontSize: 11.5,
                lineHeight: 1.7,
              }}
            />
          </Field>
          <Field label="resolve 函数" hint="模块.函数，如 werewolf.resolve_action">
            <input
              value={f.resolve || ''}
              onChange={(e) => u({ resolve: e.target.value.trim() })}
              placeholder="q.answer"
              style={{ ...inp, fontFamily: 'var(--femo-font-mono)' }}
            />
          </Field>
          <Field label="resolve 参数" hint="逗号分隔，如 prompt, llm_output, count">
            <input
              value={f.resolveArgs || ''}
              onChange={(e) => u({ resolveArgs: e.target.value.trim() })}
              placeholder="prompt, llm_output, count"
              style={{ ...inp, fontFamily: 'var(--femo-font-mono)' }}
            />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="最大重试次数">
              <input
                type="number"
                value={f.maxRetries || 0}
                onChange={(e) => u({ maxRetries: parseInt(e.target.value) || 0 })}
                style={{ ...inp, width: '100%' }}
              />
            </Field>
            <Field label="fallback">
              <input
                value={f.fallback || ''}
                onChange={(e) => u({ fallback: e.target.value.trim() })}
                placeholder="retry / abort"
                style={{ ...inp }}
              />
            </Field>
          </div>
          <Field label="interrupt" hint="HUMAN 可暂停等待输入">
            <input
              value={f.interrupt || ''}
              onChange={(e) => u({ interrupt: e.target.value.trim() })}
              placeholder="HUMAN"
              style={inp}
            />
          </Field>
          <Field label="Memory 配置" hint="如 memory: default">
            <input
              value={f.memory || ''}
              onChange={(e) => u({ memory: e.target.value.trim() })}
              placeholder="default"
              style={inp}
            />
          </Field>
          <Field label="Context 配置" hint="如 context: default">
            <input
              value={f.context || ''}
              onChange={(e) => u({ context: e.target.value.trim() })}
              placeholder="default"
              style={inp}
            />
          </Field>


          <Field label="out 变量" hint="变量名(类型, '说明'), 逗号分隔">
            <input
              value={f.outVars}
              onChange={(e) => u({ outVars: e.target.value })}
              placeholder="kill_target(string, '击杀目标')"
              style={inp}
            />
          </Field>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 18,
              paddingTop: 16,
              borderTop: 'var(--femo-border-w) solid var(--femo-border)',
            }}
          >
            <button onClick={onClose} style={btnS}>
              取消
            </button>
            <button
              onClick={() => {
                if (!f.name.trim()) return;
                if (nameErr) return;
                onSave({ ...f, id: init?.id || aid() });
              }}
              style={{
                ...btnP,
                background: type.c,
                opacity: f.name.trim() && !nameErr ? 1 : 0.5,
              }}
            >
              保存 Action
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


export { ActionModal };
