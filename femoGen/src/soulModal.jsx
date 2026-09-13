// ════════════════════════════════════════
// ═══════    soulModal.jsx       ═════════
// ════════════════════════════════════════


import React, { useState } from 'react';
import { inp, btnP, btnS } from './common';

function SoulModal({ open, onClose, onCreated, createUrl = '/api/souls/create' }) {
  const [soulForm, setSoulForm] = useState({
    soul_id: '',
    soul_name: '',
    description: '',
  });
  const [soulFormError, setSoulFormError] = useState('');
  const [soulFormSubmitting, setSoulFormSubmitting] = useState(false);

  if (!open) return null;

  const handleCreateSoul = async () => {
    if (!soulForm.soul_id.trim()) {
      setSoulFormError('Soul ID 不能为空');
      return;
    }
    setSoulFormSubmitting(true);
    setSoulFormError('');
    try {
      const res = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(soulForm),
      });
      const data = await res.json();
      if (data.error) {
        setSoulFormError(data.error);
      } else {
        onCreated && onCreated(data);
        onClose();
      }
    } catch (e) {
      setSoulFormError(e.message);
    } finally {
      setSoulFormSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        background: 'var(--femo-mask-soft)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--femo-surface)',
          borderRadius: 'var(--femo-radius-xl)',
          padding: '28px 32px',
          width: 420,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px var(--femo-shadow-md)',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--femo-text-1)', marginBottom: 18 }}>
          🆔 新建 SOUL ID
        </div>

        {/* soul_id */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--femo-primary)', marginBottom: 4 }}>
            Soul ID <span style={{ color: 'var(--femo-danger)' }}>*</span>
          </div>
          <input
            value={soulForm.soul_id}
            onChange={(e) => setSoulForm({ ...soulForm, soul_id: e.target.value.replace(/[^a-zA-Z0-9]/g, '') })}
            placeholder="英文+数字，不可重复"
            style={{ ...inp, width: '100%' }}
            autoFocus
          />
        </div>

        {/* soul_name */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--femo-primary)', marginBottom: 4 }}>
            Soul Name
          </div>
          <input
            value={soulForm.soul_name}
            onChange={(e) => setSoulForm({ ...soulForm, soul_name: e.target.value })}
            placeholder="角色名称，可重复"
            style={{ ...inp, width: '100%' }}
          />
        </div>

        {/* description */}
        <div style={{ marginBottom: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--femo-primary)', marginBottom: 4 }}>
            Description
          </div>
          <textarea
            value={soulForm.description}
            onChange={(e) => setSoulForm({ ...soulForm, description: e.target.value })}
            placeholder="角色的 System Prompt，定义角色的行为和人格..."
            style={{ ...inp, width: '100%', minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>


        {/* 错误提示 */}
        {soulFormError && (
          <div
            style={{
              background: 'var(--femo-danger-soft)',
              color: 'var(--femo-danger-strong)',
              padding: '8px 12px',
              borderRadius: 'var(--femo-radius-md)',
              fontSize: 12,
              marginBottom: 12,
              border: 'var(--femo-border-w) solid var(--femo-danger-border)',
            }}
          >
            {soulFormError}
          </div>
        )}

        {/* 按钮 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button
            onClick={() => {
              onClose();
              setSoulFormError('');
            }}
            style={btnS}
          >
            取消
          </button>
          <button
            onClick={handleCreateSoul}
            disabled={soulFormSubmitting}
            style={{
              ...btnP,
              background: 'var(--femo-primary)',
              opacity: soulFormSubmitting ? 0.6 : 1,
              cursor: soulFormSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            {soulFormSubmitting ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { SoulModal };
