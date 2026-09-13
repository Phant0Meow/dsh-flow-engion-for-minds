/**
 * client-ui/styles.ts — femo-stream 样式表（一次性注入）。
 *
 * 官方 ReasoningRow.module.css 的 .femo-rr-* 转写（--dsw-alias-* token 同款，
 * 浅色/深色自适应；rc 升级需对照重放）+ 直播容器与光标。不走 css module
 * （构建链不注入插件侧 css），沿用母名黑化的 style 元素路线。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 *
 * 2026-08-26 追加 FEMO_COMPOSER_CSS：投影窗 composer 官方同款胶囊卡片
 * （ui-conversation InputBar.module.css 逐属性转写，femo-comp-* 前缀），
 * 全 --dsw/--dsh token 零写死色值 → 深浅色与第三方主题自动跟随主窗口。
 */

const FEMO_STREAM_CSS = `
.femo-stream-root{display:flex;flex-direction:column;margin:2px 0 10px}
.femo-stream-toolline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0}
/* ── 官方工具行（2026-08-30 V6.1）：ui-tool ToolRow.module.css 逐属性转写
   （femo-toolrow-* 前缀）。骨架件 DisclosureRow/StateDot/图标是 primitives
   真件（external→shell 同实例，自带样式），此处只补行级几何与状态样式。
   全 --dsw token 零写死色值 → 深浅色/第三方主题自动跟随。 */
.femo-toolrow{display:flex;flex-direction:column}
.femo-toolrow-row{position:relative;overflow:hidden}
.femo-toolrow[data-state='running'] .femo-toolrow-row::after{content:'';position:absolute;top:0;bottom:0;left:0;width:300px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent) 55%,transparent 100%);animation:femo-tool-row-sweep 2.6s ease-out infinite;pointer-events:none}
@keyframes femo-tool-row-sweep{0%{left:-300px}90%,100%{left:100%}}
.femo-toolrow-leading{flex-shrink:0}
.femo-toolrow-chevron{color:var(--dsw-alias-label-secondary)}
.femo-toolrow-title{font-weight:400}
.femo-toolrow-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}
.femo-toolrow-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:24px;color:var(--dsw-alias-label-tertiary)}
.femo-toolrow-bodywrap{display:flex;flex-direction:column}
.femo-toolrow-iocard{display:flex;flex-direction:column;margin:4px 0 4px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}
.femo-toolrow-iosection{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;align-items:baseline;padding:12px 16px;max-height:150px;overflow-y:auto}
.femo-toolrow-iosection::-webkit-scrollbar-thumb{border:2px solid transparent;background-clip:padding-box;border-radius:6px}
.femo-toolrow-iosection::-webkit-scrollbar-track{margin:6px 0}
.femo-toolrow-iolabel{position:sticky;top:0;align-self:start;color:var(--dsw-alias-label-caption)}
.femo-toolrow-iodivider{flex:none;height:1px;background:var(--dsw-alias-border-l2)}
.femo-toolrow-iotext{min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
.femo-toolrow-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* 2026-08-26 拆除自绘闪烁光标（.femo-stream-caret/femo-caret-blink）：官方流式
   输出无 caret 装饰，Deep diving 状态行已承担"进行中"信号（猫猫裁定）。 */
/* 官方 ChatView TurnStatus 同款转写（2026-08-26）：品牌蓝流光 "Deep diving..."
   （rc.2 ChatView.module.css .turnStatus/.turnStatusClock 逐属性重放，类名换
   femo- 前缀——构建链不注入插件侧 css module，沿用 style 元素路线）。 */
.femo-turn-status{align-self:flex-start;flex:none;display:inline-flex;align-items:center;height:26px;font:var(--dsw-font-s-strong-14);white-space:nowrap;background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);background-position:100% 0;background-size:250% 100%;background-clip:text;color:transparent;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:femo-turn-status-shimmer 1.8s linear infinite}
.femo-turn-status-clock{margin-left:8px;font:var(--dsw-font-xs-13);font-weight:400;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);-webkit-text-fill-color:var(--dsw-alias-label-caption)}
@keyframes femo-turn-status-shimmer{to{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.femo-turn-status{background-position:0 0;background-size:100% 100%;animation:none}}
.femo-rr-root{display:flex;flex-direction:column}
.femo-rr-row{position:relative;overflow:hidden}
.femo-rr-root[data-state='running'] .femo-rr-row::after{content:'';position:absolute;inset-block:0;left:0;width:300px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent) 55%,transparent 100%);animation:femo-rr-sweep 2.6s ease-out infinite;pointer-events:none}
@keyframes femo-rr-sweep{0%{left:-300px}90%,100%{left:100%}}
.femo-rr-leading{flex-shrink:0}
.femo-rr-chevron{color:var(--dsw-alias-label-secondary)}
.femo-rr-title{font-weight:400}
.femo-rr-separator{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.femo-rr-summary{min-width:0;overflow:hidden;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;text-overflow:ellipsis;white-space:nowrap}
.femo-rr-summary[data-follow-end]{text-overflow:clip}
.femo-rr-think-body{padding:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:pre-wrap;word-break:break-word}
.femo-a11y-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.femo-rr-root[data-state='running'] .femo-rr-row::after{animation:none}}
`

/** 投影窗 composer：官方 InputBar 视觉的逐属性转写（rc.2 InputBar.module.css，
 * 类名换 femo-comp-* 前缀；rc 升级需对照重放）。布局 token 定义在
 * ConversationRoot 的祖先链上（.root / .composerSeat），槽位内继承可得；
 * fallback 值仅兜变量缺失，不改变正常主题下的解析。 */
const FEMO_COMPOSER_CSS = `
.femo-comp-root{display:flex;flex-direction:column;align-items:center;padding:0 var(--dsh-composer-side-clearance,16px) 8px}
.femo-comp-notice{width:100%;max-width:var(--dsh-composer-card-max-width,780px);margin-bottom:6px;padding:4px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.femo-comp-card{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:12px;width:100%;max-width:var(--dsh-composer-card-max-width,780px);padding-top:10px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:22px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);font-family:var(--dsw-font-family);font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.femo-comp-scroll{max-height:var(--dsh-composer-text-max-height,336px);overflow-y:auto}
.femo-comp-grow{position:relative}
/* 官方 mirror 自增高技术（无 backdrop 层）：mirror 流内定高、textarea 绝对
   覆盖；两层共享同一套度量与换行规则，高度才不会分叉。 */
.femo-comp-mirror,.femo-comp-input{box-sizing:border-box;padding:4px 12px 0 16px;font-family:inherit;font-size:inherit;line-height:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.femo-comp-mirror{visibility:hidden;pointer-events:none}
.femo-comp-input{position:absolute;inset:0;width:100%;height:100%;display:block;border:none;outline:none;resize:none;overflow:hidden;background:transparent;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary)}
.femo-comp-input[readonly]{color:var(--dsw-alias-label-tertiary)}
.femo-comp-input::placeholder{color:var(--dsw-alias-label-caption);-webkit-text-fill-color:var(--dsw-alias-label-caption);user-select:none}
/* 工具行：官方 .row 同款（左组预留空、右组发送钮）；2px 顶移补偿同官方。 */
.femo-comp-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:2px 8px 6px;min-width:0}
.femo-comp-trailing{display:flex;align-items:center;min-width:0;margin-left:auto;gap:12px}
.femo-comp-primary{display:grid;place-items:center;flex:none;width:34px;height:34px;border:none;border-radius:999px;background:var(--dsw-alias-button-info-fill,#3964FE);color:#fff;cursor:pointer;transition:background-color 100ms ease;transform:translateY(-2px)}
.femo-comp-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.femo-comp-primary:disabled{opacity:.4;cursor:default}
/* 空座位幽灵 gap 反制（2026-08-26）：官方 ChatView 用 .flowItem:empty 兜底
   "decline 的座位不吃列 gap"，但 SlotOutlet 恒输出 <div data-slot
   style="display:contents"> 包装（ui-renderer 锚点契约）——decline 组件的
   座位永远有子节点（data-slot div），:empty 与 :has(*) 都不命中，零高座位
   照吃 column 的 16px gap。femo 锚点密度高（user/message+step/start 每步
   双锚点），工具序列中间叠出 N×16px 幽灵间距。正确选择器=检查 data-slot
   wrapper 内部是否真空（:not(:has([data-slot] *))）；官方 turn-tail 同病
   顺手一并反制（不动本体文件）。 */
[data-chat-flow-kind='femo-director']:not(:has([data-slot] *)){display:none}
[data-chat-flow-kind='femo-role']:not(:has([data-slot] *)){display:none}
[data-chat-flow-kind='turn-tail']:not(:has([data-slot] *)){display:none}
/* 权限菜单 trigger：官方 PermissionSelect.module.css .trigger 家族逐属性转写
   （femo-comp-perm-*）；菜单体与风险确认弹窗用 ui-primitives 的 Menu /
   RiskConfirmation 官方组件，无需自绘。 */
.femo-comp-perm-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;font-family:inherit;cursor:pointer}
.femo-comp-perm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.femo-comp-perm-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.femo-comp-perm-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.femo-comp-perm-icon{display:inline-flex;flex:0 0 auto}
.femo-comp-perm-icon svg{width:14px;height:14px}
.femo-comp-perm-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.femo-comp-perm-chevron{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}
.femo-comp-perm-chevron[data-open='true']{transform:rotate(180deg)}
/* 统计行：官方 StatsLine.module.css 逐属性转写（femo-comp-stats-*），
   对齐共享消息列轴（--dsh-chat-content-width）。 */
.femo-comp-stats{display:block;text-align:center;max-width:var(--dsh-chat-content-width,748px);width:100%;margin:0 auto;box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance,16px) + 16px) 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.femo-comp-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px}
/* 上下文占用圆环：官方 ContextMeter.module.css 逐属性转写（femo-comp-meter-*，
 * tint 变量换 femo 前缀防撞名）。上帝窗=主会话 contextPressure 数据；角色窗
 * 复用同款视觉换 actor-usage 数据源。面板=menu surface（r12/反色细边/lv3 阴影）。 */
.femo-comp-meter{position:relative;display:inline-flex}
.femo-comp-meter-trigger{display:grid;place-items:center;flex:none;width:28px;height:28px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.femo-comp-meter-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.femo-comp-meter-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2}
.femo-comp-meter-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2;stroke-linecap:round}
.femo-comp-meter-panel{position:absolute;bottom:calc(100% + 8px);right:0;z-index:100;box-sizing:border-box;width:264px;padding:12px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:default}
.femo-comp-meter-header{display:flex;align-items:center;gap:6px}
.femo-comp-meter-figures{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.femo-comp-meter-percent{font-weight:500;color:var(--dsw-alias-label-primary)}
.femo-comp-meter-headline{color:var(--dsw-alias-label-tertiary)}
.femo-comp-meter-bar{display:flex;gap:1px;margin:10px 0 12px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.femo-comp-meter-segment{flex:none;min-width:2px;height:100%;border-radius:1px;background:var(--femo-meter-tint,var(--dsw-alias-label-tertiary))}
.femo-comp-meter-swatch{display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:2px;background:var(--femo-meter-tint);vertical-align:baseline}
.femo-comp-meter-tint-system{--femo-meter-tint:var(--dsw-static-neutral-bluish-400)}
.femo-comp-meter-tint-tools{--femo-meter-tint:rgb(167,139,250)}
.femo-comp-meter-tint-messages{--femo-meter-tint:var(--dsw-static-blue-450)}
.femo-comp-meter-rows{margin:6px 0 0}
.femo-comp-meter-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0}
.femo-comp-meter-row dt{color:var(--dsw-alias-label-secondary)}
.femo-comp-meter-row dd{margin:0;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
`

export function ensureFemoStreamStyles(): void {
  if (document.getElementById('femo-stream-style') !== null) return
  const el = document.createElement('style')
  el.id = 'femo-stream-style'
  el.textContent = FEMO_STREAM_CSS + FEMO_COMPOSER_CSS
  document.head.appendChild(el)
}
