// ════════════════════════════════════════
// ═══════.  projectPanel.jsx     ═════════
// ════════════════════════════════════════

import React, { useState, useEffect } from 'react';
import { Field, PR, inp, btnP, btnS, TYPES } from './common';

/** 拉取 dsh 可用模型列表（宿主 /dsh-femo/models，聚合 ctx.llm）。
 * 返回 [models, err]：models = {defaultProvider, providers:[{id, models:[{id}]}]} 或 null。 */
export function useModelList() {
  const [models, setModels] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/dsh-femo/models')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.ok) setModels(d);
        else setErr(d.error || '无法获取模型列表');
      })
      .catch(() => {
        if (alive) setErr('无法获取模型列表');
      });
    return () => {
      alive = false;
    };
  }, []);
  return [models, err];
}

/** source 下拉选项：默认空（跟随主模型）+ 全部 provider/model；当前值不在列表时追加原值（防丢）。 */
export function sourceOptions(models, current) {
  const opts = [{ value: '', label: '跟随主模型（默认）' }];
  if (models) {
    for (const p of models.providers || []) {
      for (const m of p.models || []) {
        const v = `${p.id}/${m.id}`;
        opts.push({ value: v, label: v });
      }
    }
  }
  const cur = (current || '').trim();
  if (cur && !opts.some((o) => o.value === cur)) {
    opts.push({ value: cur, label: `${cur}（自定义）` });
  }
  return opts;
}

function ProjPanel({ proj, actorNames, onChange }) {
  const u = (x) => onChange({ ...proj, ...x });
  // 「输入工具」选中态（按 actor 名）：tools 数组清空时仍保持 custom 态，
  // 与「未声明」（空数组=剧本未写）区分——否则点选后空数组被误判为未选。
  const [customSel, setCustomSel] = useState({});
  // dsh 可用模型列表（source 下拉数据源）
  const [models, modelErr] = useModelList();
  return (
    <div>
      <Field label="项目名称">
        <input
          value={proj.name}
          onChange={(e) => u({ name: e.target.value })}
          style={inp}
        />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Version" hint="">
          <input
            value={proj.version}
            onChange={(e) => u({ version: e.target.value })}
            placeholder="1.0"
            style={{ ...inp }}
          />
        </Field>
        <Field label="Owner" hint="user_id">
          <input
            value={proj.owner}
            onChange={(e) => u({ owner: e.target.value })}
            placeholder="1"
            style={{ ...inp }}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Database">
          <input
            value={proj.database}
            onChange={(e) => u({ database: e.target.value })}
            placeholder="memory/Chronica.wor"
            style={{ ...inp }}
          />
        </Field>
        <Field label="Session">
          <input
            value={proj.session}
            onChange={(e) => u({ session: e.target.value })}
            placeholder="new"
            style={{ ...inp }}
          />
        </Field>
      </div>
      <Field label="节点延迟(s)" hint="每个节点执行前的等待秒数">
        <input
          type="number"
          value={proj.delay ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            u({ delay: v === '' ? undefined : Number(v) });
          }}
          style={{ ...inp, width: '100%' }}
          step="0.1"
          min="0"
          placeholder="例如 10"
        />
      </Field>
      <Field label="System Safety">
        <textarea
          value={proj.system_safety}
          onChange={(e) => u({ system_safety: e.target.value })}
          rows={2}
          placeholder="安全须知..."
          style={{ ...inp, resize: 'vertical', lineHeight: 1.55 }}
        />
      </Field>
      <Field label="Output Style">
        <textarea
          value={proj.output_style}
          onChange={(e) => u({ output_style: e.target.value })}
          rows={2}
          placeholder="输出风格要求..."
          style={{ ...inp, resize: 'vertical', lineHeight: 1.55 }}
        />
      </Field>

      <div style={{ marginTop: 2 }}>
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
              fontSize: 10,
              fontWeight: 800,
              color: 'var(--femo-neutral)',
              textTransform: 'uppercase',
              letterSpacing: '0.09em',
            }}
          >
            Actors
          </span>
          <button
            onClick={() =>
              u({
                actors: [
                  ...(proj.actors || []),
                  {
                    name: '',
                    type: 'ai',
                    soul: '',
                    source: '',
                    tools: null,   // 未声明 = 宿主默认全开（[] 是显式空白名单 ≡ 禁用，别混）
                    thinking: '',
                  },
                ],
              })
            }
            style={{ ...btnP, padding: '4px 11px', fontSize: 11 }}
          >
            +
          </button>
        </div>
        {(proj.actors || []).map((a, i) => {
          const upd = (x) =>
            u({
              actors: proj.actors.map((p, j) => (j === i ? { ...p, ...x } : p)),
            });
          const actorName = a.name.replace('@', '');
          const nameConflict =
            actorName &&
            actorNames.includes(actorName) &&
            proj.actors.findIndex(
              (p, j) => j !== i && p.name.replace('@', '') === actorName
            ) !== -1;
          return (
            <div
              key={i}
              style={{
                background: 'var(--femo-bg)',
                border: `var(--femo-border-w) solid ${nameConflict ? 'var(--femo-danger)' : 'var(--femo-border)'}`,
                borderRadius: 'var(--femo-radius-md)',
                padding: '9px 10px',
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 5,
                  marginBottom: 5,
                  alignItems: 'center',
                }}
              >
                <select
                  value={a.type}
                  onChange={(e) => upd({ type: e.target.value })}
                  style={{
                    ...inp,
                    // 宽度自适应内容（ai/human），不随栏宽收缩
                    width: 'auto',
                    flex: '0 0 auto',
                    padding: '5px 6px',
                    fontSize: 11,
                  }}
                >
                  <option value="ai">ai</option>
                  <option value="human">human</option>
                </select>
                <input
                  value={a.name}
                  onChange={(e) => {
                    let v = e.target.value.trim();
                    if (v && !v.startsWith('@')) v = '@' + v;
                    upd({ name: v });
                  }}
                  placeholder="@Alice"
                  style={{
                    ...inp,
                    flex: 1,
                    padding: '5px 8px',
                    fontSize: 11.5,
                    borderColor: nameConflict ? 'var(--femo-danger)' : undefined,
                  }}
                />
                <button
                  onClick={() =>
                    u({ actors: proj.actors.filter((_, j) => j !== i) })
                  }
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--femo-danger-weak)',
                    fontSize: 17,
                    lineHeight: 1,
                  }}
                >
                  x
                </button>
              </div>
              {nameConflict && (
                <div
                  style={{ fontSize: 10, color: 'var(--femo-danger)', marginBottom: 4 }}
                >
                  名称 "{actorName}" 与 action/module 重名
                </div>
              )}
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  value={a.soul}
                  onChange={(e) => upd({ soul: e.target.value })}
                  placeholder="soul:1"
                  style={{ ...inp, flex: 1, padding: '4px 7px', fontSize: 11 }}
                />
                {a.type === 'ai' && models ? (
                  <select
                    value={a.source || ''}
                    onChange={(e) => upd({ source: e.target.value })}
                    title="来源模型（dsh 可用列表；空=插件配置默认）"
                    style={{ ...inp, flex: 1, padding: '4px 7px', fontSize: 11 }}
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
                    style={{ ...inp, flex: 1, padding: '4px 7px', fontSize: 11 }}
                  />
                )}
              </div>
              {a.type === 'ai' && (
                <div style={{ marginTop: 5 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: 'var(--femo-text-3)',
                      marginBottom: 4,
                    }}
                  >
                    Tools
                  </div>
                  {/* 全或无三态：true=全部 / false=关闭 / 数组=白名单（自定义列表）；未声明=不选（宿主默认全开） */}
                  {(() => {
                    const toolsMode = customSel[a.name]
                      ? 'custom'
                      : a.tools === true ? 'all'
                        : a.tools === false ? 'off'
                          : Array.isArray(a.tools) && a.tools.length > 0 ? 'custom'
                            : null;
                    const customText = Array.isArray(a.tools) ? a.tools.join(', ') : '';
                    const clearCustom = () => {
                      const next = { ...customSel };
                      delete next[a.name];
                      setCustomSel(next);
                    };
                    const modes = [
                      { id: 'all', label: '所有工具' },
                      { id: 'off', label: '关闭工具' },
                      { id: 'custom', label: '输入工具' },
                    ];
                    return (
                      <>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          {modes.map((m) => (
                            <label
                              key={m.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 3,
                                fontSize: 10.5,
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                type="radio"
                                checked={toolsMode === m.id}
                                onChange={() => {
                                  if (m.id === 'all') {
                                    clearCustom();
                                    upd({ tools: true });
                                  } else if (m.id === 'off') {
                                    clearCustom();
                                    upd({ tools: false });
                                  } else {
                                    setCustomSel({ ...customSel, [a.name]: true });
                                    upd({ tools: [] });
                                  }
                                }}
                              />
                              {m.label}
                            </label>
                          ))}
                        </div>
                        {toolsMode === 'custom' && (
                          <input
                            value={customText}
                            onChange={(e) => {
                              const list = e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean);
                              upd({ tools: list });
                            }}
                            placeholder="deep_think, web_search, shell"
                            style={{ ...inp, marginTop: 6, padding: '4px 7px', fontSize: 11 }}
                          />
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
              {a.type === 'ai' && (
                <div style={{ marginTop: 5 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: 'var(--femo-text-3)',
                      marginBottom: 4,
                    }}
                  >
                    Thinking
                  </div>
                  {/* 思考档位：Default=未声明（不发 reasoning_effort，服务器/部署默认自选，
                      与 dsh 模型选择器 Default 项同语义）；其余档位按写的走，
                      模型不支持时请求前报错（fail loud）。词汇与 Python 编译器对齐。 */}
                  <select
                    value={a.thinking || ''}
                    onChange={(e) => upd({ thinking: e.target.value })}
                    style={{ ...inp, width: '100%', padding: '4px 7px', fontSize: 11 }}
                  >
                    <option value="">Default</option>
                    {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((lv) => (
                      <option key={lv} value={lv}>{lv}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--femo-neutral)', textTransform: 'uppercase', letterSpacing: '0.09em' }}>
            Vars
          </span>
          <button
            onClick={() => u({ vars: [...(proj.vars || []), { name: '', defaultValue: '' }] })}
            style={{ ...btnP, padding: '4px 11px', fontSize: 11 }}
          >
            +
          </button>
        </div>
        {(proj.vars || []).map((v, i) => (
          <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
            <input
              value={v.name}
              onChange={(e) => {
                const upd = [...proj.vars];
                upd[i] = { ...upd[i], name: e.target.value };
                u({ vars: upd });
              }}
              placeholder="变量名"
              style={{ ...inp, flex: 1, padding: '5px 8px', fontSize: 11.5 }}
            />
            <input
              value={v.defaultValue}
              onChange={(e) => {
                const upd = [...proj.vars];
                upd[i] = { ...upd[i], defaultValue: e.target.value };
                u({ vars: upd });
              }}
              placeholder="默认值"
              style={{ ...inp, flex: 2, padding: '5px 8px', fontSize: 11.5 }}
            />
            <button
              onClick={() => u({ vars: proj.vars.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--femo-danger-weak)', fontSize: 17, lineHeight: 1 }}
            >
              x
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
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
              fontSize: 10,
              fontWeight: 800,
              color: 'var(--femo-neutral)',
              textTransform: 'uppercase',
              letterSpacing: '0.09em',
            }}
          >
            Code
          </span>
          <button
            onClick={() =>
              u({ code: [...(proj.code || []), { name: '', value: '' }] })
            }
            style={{ ...btnP, padding: '4px 11px', fontSize: 11 }}
          >
            +
          </button>
        </div>
        {(proj.code || []).map((c, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 5,
              marginBottom: 5,
              alignItems: 'center',
            }}
          >
            <input
              value={c.name}
              onChange={(e) => {
                const upd = [...proj.code];
                upd[i] = { ...upd[i], name: e.target.value };
                u({ code: upd });
              }}
              placeholder="名称"
              style={{ ...inp, flex: 1, padding: '5px 8px', fontSize: 11.5 }}
            />
            <input
              value={c.value}
              onChange={(e) => {
                const upd = [...proj.code];
                upd[i] = { ...upd[i], value: e.target.value };
                u({ code: upd });
              }}
              placeholder="文件路径（如 utils.py）"
              style={{ ...inp, flex: 2, padding: '5px 8px', fontSize: 11.5 }}
            />
            <button
              onClick={() => u({ code: proj.code.filter((_, j) => j !== i) })}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--femo-danger-weak)',
                fontSize: 17,
                lineHeight: 1,
              }}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


export { ProjPanel };
