/**
 * section-gate.ts — 投影窗「回合区块」按开跑顺序整段落盘的闸门（2026-09-10 v7）。
 *
 * 需求（猫猫 2026-09-10）：上帝窗段落顺序 = 演员开跑顺序（甲乙乙甲），段内
 * 名字+内容恒完整，且一经出现绝不换位。旧的「骨架即时落盘 + 内容 turn/end
 * 才落盘」两头不讨好：骨架即时 ⇒ 名字先出现；内容关闭时才落 ⇒ par 交错下
 * 内容物理位置在别人骨架之后，head 锚一追内容段落顺序就漂移（甲乙乙变
 * 乙乙甲甲，第一个甲跑到底部，实测）。
 *
 * 方案：整段（turn/start、speaker/📢、step 骨架、内容块、错误行、turn/end）
 * 攒进各节点的区块缓冲，commit 后按【开跑顺序】（begin 顺序 = ai_request 到
 * 达顺序）FIFO 落盘——所有更早开跑的区块都落盘后自己才落。流式期的可见性
 * 交给窗底「直播尾」客户端节点（femo-live-tail，锚定日志末尾，由宿主开跑时
 * 即时写下的 kind='live' 轻锚驱动），区块落盘时 end 帧随 runner 同步放行，
 * 直播文字无缝移交，无闪烁空窗。
 *
 * 同角色防串桶：同角色下一节点的流式帧不得混进上一回合仍保留的直播桶
 * （(index,step) 同键会把两次发言拼成乱码）——waitActorFlush 让同角色下一
 * 节点在上一区块落盘前不派发（原生路径在 per-actor 锁之后、startContinuable
 * /sendMessage 之前 await）。
 *
 * 全部内存态；重启即空（持有中的区块与旧 V6 缓冲同命运）。runner 均为同步
 * 写窗（projectionAppend 无 await），tryFlush 在单线程下绝不交错。
 */

interface GateEntry {
  turn: number
  actorKey: string
  ready: boolean
  run?: () => void
  /** begin 时创建的本区块落盘钩子：同角色下一节点 waitActorFlush 等的就是它。 */
  hook?: { promise: Promise<void>; resolve: () => void }
}

// 【诊断 2026-09-11 临时】闸门三个动作全部落 diag 日志（right-top log 窗可看）。
import { projTrace, t4 } from './proj-trace'

function actorKeyOf(sid: string, actorKey: string): string {
  return `${sid}\u0000${actorKey}`
}

class SectionGate {
  private queues = new Map<string, GateEntry[]>()
  private actorLast = new Map<string, { promise: Promise<void>; resolve: () => void }>()

  /** 节点开跑（ai_request 处理起点）登记：占据本区块在 FIFO 里的顺位。
   *  同 turn 重复 begin 幂等忽略。 */
  begin(sid: string, turn: number, actorKey: string): void {
    let q = this.queues.get(sid)
    if (q === undefined) {
      q = []
      this.queues.set(sid, q)
    }
    if (q.some(e => e.turn === turn)) return
    const entry: GateEntry = { turn, actorKey, ready: false }
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    entry.hook = { promise, resolve }
    q.push(entry)
    this.actorLast.set(actorKeyOf(sid, actorKey), entry.hook)
    projTrace('gate', `begin turn=${t4(turn)} actor=${actorKey} 队列长=${q.length} 队首=${t4(q[0]?.turn)} 就绪=${q.map(e => (e.ready ? 'R' : '-')).join('')}`)
  }

  /** 同角色上一区块的落盘完成钩子（未登记过 = 立即通过）。调用方必须在
   *  begin(自己的回合) 之前 await，拿到的才是上一回合的钩子。 */
  waitActorFlush(sid: string, actorKey: string): Promise<void> {
    const hook = this.actorLast.get(actorKeyOf(sid, actorKey))
    projTrace('gate', `waitFlush actor=${actorKey} ${hook === undefined ? '（无登记=立即通过）' : '（等上一段落盘）'}`)
    return hook?.promise ?? Promise.resolve()
  }

  /** 区块就绪：挂上落盘 runner 并按序冲刷就绪前缀。
   *  - 队列里有本 turn 的 entry → 标记 ready；
   *  - 没有（重试回合等二次提交）→ 就绪 entry 排到队尾（保持相对顺序）。
   *  commit 幂等性由调用方的 released 旗标保证（同 turn 二次 commit 会作为
   *  新 entry 再排一次）。 */
  commit(sid: string, turn: number, actorKey: string, run: () => void): void {
    let q = this.queues.get(sid)
    if (q === undefined) {
      q = []
      this.queues.set(sid, q)
    }
    const entry = q.find(e => e.turn === turn)
    if (entry === undefined) {
      q.push({ turn, actorKey, ready: true, run })
    } else {
      entry.run = run
      entry.ready = true
    }
    projTrace('gate', `commit turn=${t4(turn)} actor=${actorKey} 队列长=${q.length} 队首=${t4(q[0]?.turn)} 就绪=${q.map(e => (e.ready ? 'R' : '-')).join('')}`)
    this.tryFlush(sid)
  }

  /** 冲刷就绪前缀：队首就绪则落盘并继续（FIFO，单线程同步）。 */
  private tryFlush(sid: string): void {
    const q = this.queues.get(sid)
    if (q === undefined) return
    while (q.length > 0 && q[0]!.ready && q[0]!.run !== undefined) {
      const entry = q.shift()!
      projTrace('gate', `落盘 turn=${t4(entry.turn)} actor=${entry.actorKey} 剩余队列=${q.length}`)
      entry.run!()
      entry.hook?.resolve()
    }
  }
}

/** 全插件共享单例（subagent.ts 旧路径与 subagent-native.ts 原生路径同闸）。 */
export const sectionGate: SectionGate = new SectionGate()
