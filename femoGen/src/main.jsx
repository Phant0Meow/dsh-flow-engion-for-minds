// ════════════════════════════════════════
// ═══════       main.jsx         ═════════
// ════════════════════════════════════════
// 组件入口：被 dsh-femo 的 client bundle import 渲染（插件模式）；
// 独立运行模式由 index.html 经 vite 加载本文件（ReactDOM 挂载）。
// 插件模式下字体样式由 dsh-femo 侧负责引入（见 build.mjs 说明）。

import './styles/font.css';
import ReactDOM from 'react-dom/client';
import React from 'react';
import FemoWorAuto from './FemoWorAuto';

// 仅独立运行（index.html 直开）时挂载；被 import 时静默导出组件。
if (typeof document !== 'undefined' && document.getElementById('root')) {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <FemoWorAuto />
    </React.StrictMode>
  );
}

export default FemoWorAuto;
