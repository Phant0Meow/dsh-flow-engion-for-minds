/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

const clientOptions = {
  entryPoints: ['hostAdapter/client/client.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react），
  // 不能打进 bundle——否则双 React 实例会崩掉 slots 渲染。
  // ui-primitives 同理。2026-09-04：client-runtime 从 externals 移除——rc.1 删除
  // 该包，femo 的最后一位运行时消费者（lineage-fork 的 indexSubagentDescendants）
  // 已本地化，client bundle 对已删包零引用（type-only 导入构建期擦除）。
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "dsh-femo",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

const hostOptions = {
  entryPoints: ['hostAdapter/host/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
  // dsh-session must stay external: its runtime registry (registerSessionEventType)
  // is instance state shared with the host's persistence coordinator. Bundling a
  // copy would register into a private Set the coordinator never sees. The host
  // resolves this import to the same module instance (tsx tsconfig paths -> src).
  external: ['@deepseek-ai/dsh-session'],
};

if (watch) {
  await (await context(clientOptions)).watch();
  await (await context(hostOptions)).watch();
  console.log('[build] watching hostAdapter/ for changes...');
} else {
  await Promise.all([build(clientOptions), build(hostOptions)]);
}
