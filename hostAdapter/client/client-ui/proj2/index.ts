/**
 * client-ui/proj2/index.ts — 显示层 v9 注册口 + 灰度开关（2026-09-11 重写启动）。
 *
 * 开关（同一时刻只允许一套渲染位注册，避免两代链路同抢一份数据）：
 *   URL 参数 `?proj2=0` / localStorage `femo.proj2='0'` → 回退旧链路（v5/v6/v7）
 *   缺省 = 新链路（v9）。iOS PWA 上改不了 localStorage，故用 URL 参数做回退闸门。
 *
 * 步1 只接管 AI 演员轮（头 + 直播尾）；主模型轮过渡期仍由旧 director 定义渲染，
 * 人类轮可输入见步3。
 */

import { femo2TurnDefinition, femo2TurnLiveDefinition, Femo2TurnLiveNodeView, Femo2TurnNodeView } from './turn-view'
import { femo2DumpBuckets, femo2FeedFrame } from './frame-router'

export { femo2TurnDefinition, femo2TurnLiveDefinition, Femo2TurnNodeView, Femo2TurnLiveNodeView }

/** 开关取值：'0'/'off'/'false' = 关（回退旧链路）。 */
function switchOff(value: string | null): boolean {
  return value === '0' || value === 'off' || value === 'false'
}

/** 新显示层是否启用（URL 参数优先于 localStorage；异常环境缺省启用）。 */
export function proj2Enabled(): boolean {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get('proj2')
    if (fromUrl !== null) return !switchOff(fromUrl)
    const stored = window.localStorage?.getItem('femo.proj2')
    if (stored !== null && stored !== undefined) return !switchOff(stored)
  } catch {
    /* 隐私模式/无 window：走缺省 */
  }
  return true
}

/** 注册 v9 的会话节点定义（调用方负责"只注册一套"）。 */
export function registerProj2Nodes(register: (def: unknown) => void): void {
  register(femo2TurnDefinition)
  register(femo2TurnLiveDefinition)
  console.log('[dsh-femo] proj2 (v9.4) conversation nodes registered (2: femo2-turn, femo2-turn-live)')
  // 【诊断】无 DevTools 时的兜底入口：window.__femo2Buckets('<主会话id>')、
  // window.__femo2Feed({kind:'delta',…})（离线重放用，与 SSE 同源同一函数）。
  ;(window as unknown as Record<string, unknown>).__femo2Buckets = (sid: string): unknown => femo2DumpBuckets(sid)
  ;(window as unknown as Record<string, unknown>).__femo2Feed = (frame: Record<string, unknown>): void => femo2FeedFrame(frame)
}
