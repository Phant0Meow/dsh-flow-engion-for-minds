/**
 * native-state.ts — 原生模式运行时状态（极简共享旗标）。
 *
 * windowing-native 安装时写入；projection.ts 等共享模块据此分流，避免
 * projection ↔ windowing-native 相互 require 成环。两个字段都在安装时
 * 一次性定死，此后只读。
 */
export const nativeState = {
  /** true = 原生 0.1.3+ 构建（无 registerSessionEventType）。 */
  native: false,
  /** true = 本构建持久层白名单已收录 dsh-femo/chat（实验性补丁）。
   *  决定：主会话可写 sys/role 行；投影窗走 agent-loop 持久化创建。 */
  mainChatSafe: false,
}

/** 投影窗是否用 agent-loop 持久化创建（原生 + 白名单补丁同时成立）。
 *  持久化投影窗：官方目录原生收录（openSubagent 可开）、侧边栏隐藏、
 *  重启原生恢复（不再依赖 JSONL 镜像重放）。 */
export function durableProjectionWindows(): boolean {
  return nativeState.native && nativeState.mainChatSafe
}
