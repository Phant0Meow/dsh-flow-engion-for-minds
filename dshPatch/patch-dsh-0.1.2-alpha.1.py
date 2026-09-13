#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""patch-dsh-0.1.2-alpha.1.py — 喵版 fork 重放一键补丁（MEOW 条目 3 + 条目 1）

基线: dsh-v0.1.2-alpha.1 (HEAD cd5ef81)，对应需求书 dsh-femo/dshPatch/DSH-0.1.2-fork修改需求.md
用法: python patch-dsh-0.1.2-alpha.1.py <快照根目录> [--dry-run]
      例: python patch-dsh-0.1.2-alpha.1.py D:\\myFiles\\dsh\\dsh-meow0.1.2-alpha.1

覆盖:
  MEOW 条目 3 (M-013 会话事件类型运行时注册面) — 4 处
  MEOW 条目 1 (CLI 入口拒绝默认 ~/.dsh 家目录)   — 2 处

不含 (需手动):
  MEOW 条目 4 (tool-session-query 搜索排除, 5 文件复杂改动) — 按 MEOW 条目 4 明细手改
  MEOW 条目 2 (端口外部化) — 机制条目, 无源码 diff

安全设计:
  ① 两阶段: 先对全部步骤做基线预检, 全部通过才动手; 任何一处对不上立即放弃, 不留半套改动
  ② 逐文件备份: 被修改文件旁写 .bak-meow-patch-0.1.2-alpha.1 (新文件除外)
  ③ 幂等: 重复运行自动跳过已应用步骤
  ④ fail-loud: 基线内容与 alpha.1 不符(版本不对/已手动改过)时明确报错, 绝不盲目替换
  ⑤ 字节级读写: 全程 bytes + UTF-8, 不触碰换行符与编码

注意: 本脚本与 0.1.2-alpha.1 的源码锚点一一对应。新版本快照(rc.x)落地时,
锚点可能漂移 —— 请对照新版源码核验后另写新版本号的脚本, 不要复用本文件。
"""

from __future__ import annotations

import sys
from pathlib import Path

VERSION = "0.1.2-alpha.1"
BACKUP_SUFFIX = ".bak-meow-patch-0.1.2-alpha.1"

# ── 锚点常量(全部来自 alpha.1 实读原文) ──────────────────────────────────────

# index.ts L35 现状
ANCHOR_EXPORT = "export { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'"
NEW_EXPORT_LINE = (
    "export { isKnownSessionEventType, registerSessionEventType } from './known-event-registry.ts'"
)

# coordinator.ts L12 (import 块成员, 来自 @deepseek-ai/dsh-session)
ANCHOR_COORD_IMPORT = "\n  KNOWN_SESSION_EVENT_TYPES,\n"
REPL_COORD_IMPORT = "\n  KNOWN_SESSION_EVENT_TYPES,\n  isKnownSessionEventType,\n"

# coordinator.ts L1141 (assertEventsSupported 内, 全仓唯一 fail-closed 拒绝点)
ANCHOR_COORD_GUARD = "if (KNOWN_SESSION_EVENT_TYPES.has(event.type)) continue"
REPL_COORD_GUARD = "if (isKnownSessionEventType(event.type)) continue"

# bin.ts L12 / L24 (alpha 把 parseDshArgs 从 bin.ts 搬到了 args.ts)
ANCHOR_ARGS_IMPORT = "import { parseDshArgs } from './args.ts'"
GUARD_IMPORTS = (
    "import { resolve } from 'node:path'\n"
    "import { defaultDshHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'"
)
ANCHOR_INVOCATION = "const invocation = parseDshArgs(process.argv.slice(2), readVersion())"

# bin.ts 守卫块 (rc.2 提交 dda82f7 原文, 与版本无关的逻辑自包含块)
GUARD_BLOCK = """

// Meow fork guard: this build must never touch the official npm dsh
// installation's user data. The upstream CLI falls back to the default home
// (~/.dsh) when DSH_HOME is unset; this build refuses to boot in that case,
// so a bare `pnpm dsh web` — from a script or another agent — cannot silently
// read or write the official profiles, sessions, or credentials. Launch
// through start-meow.bat (which sets DSH_HOME to the meow data directory), or
// export DSH_HOME explicitly before invoking dsh.
const meowHome = resolveDshHome()
const officialHome = resolve(defaultDshHome())
const sameHome = process.platform === 'win32'
  ? meowHome.toLowerCase() === officialHome.toLowerCase()
  : meowHome === officialHome
if (sameHome) {
  console.error(
    'dsh-meow: DSH_HOME is unset or resolves to the official home (~/.dsh).\\n'
    + 'This build refuses to touch the official npm dsh user data. '
    + 'Launch with start-meow.bat, or set DSH_HOME to your meow data directory first.',
  )
  process.exit(1)
}
"""

# 新文件: packages/core/session/src/known-event-registry.ts (rc.2 57662a0 原文)
REGISTRY_TS = """/**
 * Runtime extension of the persisted event-type vocabulary for out-of-repo
 * consumers.
 *
 * `KNOWN_SESSION_EVENT_TYPES` is generated from repository-internal
 * `SessionEventMap` declarations; downstream plugins cannot contribute to it.
 * This registry lets such a plugin admit the session event types its own log
 * appends, so the persistence read path interprets them instead of refusing
 * the log as newer-harness output. Registrations are process-global and
 * idempotent; the returned disposer removes the type (HMR-safe).
 * @module @deepseek-ai/dsh-session/known-event-registry
 */

import { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'

const registeredEventTypes = new Set<string>()

/**
 * Declare a session event type this runtime may read, in addition to the
 * generated vocabulary. Call during plugin setup, before any session whose
 * log contains the type is loaded.
 * @param type - the event type string to admit (for example `'dsh-femo/chat'`).
 * @returns a disposer that removes the registration.
 */
export function registerSessionEventType(type: string): () => void {
  registeredEventTypes.add(type)
  return () => {
    registeredEventTypes.delete(type)
  }
}

/**
 * Whether the persistence read path may interpret an event of this type:
 * generated vocabulary or an active runtime registration.
 * @param type - the event type to test.
 * @returns `true` when the type is known to this runtime.
 */
export function isKnownSessionEventType(type: string): boolean {
  return KNOWN_SESSION_EVENT_TYPES.has(type) || registeredEventTypes.has(type)
}
"""


class Step:
    """一个原子补丁步骤: done/baseline 检查 + 变换函数。"""

    def __init__(self, name, relpath, is_done, check_baseline, transform, is_new_file=False):
        self.name = name
        self.relpath = relpath
        self.is_done = is_done          # fn(content) -> bool  已应用(幂等跳过)
        self.check_baseline = check_baseline  # fn(content) -> bool  基线匹配(可应用)
        self.transform = transform      # fn(content) -> content
        self.is_new_file = is_new_file  # 新文件: 无备份, baseline = 目标不存在
        self.action = None              # validate 阶段填写: SKIP / APPLY


def build_steps(root: Path) -> list[Step]:
    core_src = root / "packages" / "core" / "session" / "src"
    coord = root / "packages" / "session" / "session-persistence" / "src" / "coordinator.ts"
    bin_ts = root / "apps" / "cli" / "src" / "bin.ts"

    return [
        Step(
            name="m013-A 新增 known-event-registry.ts",
            relpath=core_src / "known-event-registry.ts",
            is_done=lambda c: "registerSessionEventType" in c,
            check_baseline=lambda c: True,
            transform=lambda c: REGISTRY_TS,
            is_new_file=True,
        ),
        Step(
            name="m013-B index.ts 导出注册面",
            relpath=core_src / "index.ts",
            is_done=lambda c: "known-event-registry.ts'" in c,
            check_baseline=lambda c: ANCHOR_EXPORT in c,
            transform=lambda c: c.replace(ANCHOR_EXPORT, ANCHOR_EXPORT + "\n" + NEW_EXPORT_LINE, 1),
        ),
        Step(
            name="m013-C1 coordinator import 块",
            relpath=coord,
            is_done=lambda c: "\n  isKnownSessionEventType,\n" in c,
            check_baseline=lambda c: ANCHOR_COORD_IMPORT in c,
            transform=lambda c: c.replace(ANCHOR_COORD_IMPORT, REPL_COORD_IMPORT, 1),
        ),
        Step(
            name="m013-C2 coordinator 拒绝点接线",
            relpath=coord,
            is_done=lambda c: REPL_COORD_GUARD in c,
            check_baseline=lambda c: ANCHOR_COORD_GUARD in c,
            transform=lambda c: c.replace(ANCHOR_COORD_GUARD, REPL_COORD_GUARD, 1),
        ),
        Step(
            name="guard-1 bin.ts home-paths import",
            relpath=bin_ts,
            is_done=lambda c: "@deepseek-ai/dsh-home-paths" in c,
            check_baseline=lambda c: ANCHOR_ARGS_IMPORT in c and "from 'node:path'" not in c,
            transform=lambda c: c.replace(ANCHOR_ARGS_IMPORT, ANCHOR_ARGS_IMPORT + "\n" + GUARD_IMPORTS, 1),
        ),
        Step(
            name="guard-2 bin.ts 守卫块",
            relpath=bin_ts,
            is_done=lambda c: "Meow fork guard" in c,
            check_baseline=lambda c: ANCHOR_INVOCATION in c,
            transform=lambda c: c.replace(ANCHOR_INVOCATION, ANCHOR_INVOCATION + GUARD_BLOCK, 1),
        ),
    ]


def read_file(p: Path) -> str:
    return p.read_bytes().decode("utf-8")


def write_file(p: Path, content: str) -> None:
    p.write_bytes(content.encode("utf-8"))


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv
    if len(args) != 1:
        print(__doc__)
        return 2
    root = Path(args[0]).resolve()
    if not (root / "package.json").exists():
        print(f"[FAIL] {root} 不是快照根目录(缺 package.json)")
        return 2

    print(f"快照根目录: {root}")
    print(f"补丁版本:   {VERSION}" + ("   [DRY-RUN 只预检不改]" if dry_run else ""))
    print()

    steps = build_steps(root)

    # ── Phase 1: 预检(全部通过才动手) ──
    plan: list[tuple[Step, str]] = []  # (step, content)  content=变换前内容
    fatal = False
    for s in steps:
        if s.is_new_file:
            if s.relpath.exists():
                content = read_file(s.relpath)
                if s.is_done(content):
                    s.action = "SKIP"
                else:
                    print(f"[FAIL] {s.relpath} 已存在但不含预期特征, 内容不明, 拒绝覆盖")
                    fatal = True
                    continue
            else:
                s.action = "APPLY"
                plan.append((s, ""))
            tag = "  (新文件)" if s.is_new_file and s.action == "APPLY" else ""
            print(f"[{'SKIP' if s.action == 'SKIP' else 'OK  '}] 预检 {s.name}{tag}")
            continue

        if not s.relpath.exists():
            print(f"[FAIL] 缺文件 {s.relpath}")
            fatal = True
            continue
        content = read_file(s.relpath)
        if s.is_done(content):
            s.action = "SKIP"
        elif s.check_baseline(content):
            s.action = "APPLY"
            plan.append((s, content))
        else:
            print(f"[FAIL] 基线不匹配 {s.relpath} (步骤 {s.name})")
            print("       → 快照版本可能不是 " + VERSION + ", 或文件已被手动改动; 拒绝盲改")
            fatal = True
            continue
        print(f"[{'SKIP' if s.action == 'SKIP' else 'OK  '}] 预检 {s.name}")

    if fatal:
        print("\n预检未全部通过, 已放弃(未修改任何文件)。")
        return 1

    if not any(s.action == "APPLY" for s, _ in plan):
        print("\n全部步骤均已应用过, 无需改动。")
        return 0

    # ── Phase 2: 应用(带备份) ──
    if dry_run:
        print(f"\n[DRY-RUN] 将应用 {sum(1 for s, _ in plan)} 处改动(未实际写入)。")
        return 0

    print()
    touched = 0
    for s, _ in plan:
        if s.is_new_file:
            write_file(s.relpath, s.transform(""))
        else:
            # 关键: 每步执行前重读磁盘当前内容 —— 同一文件有多个步骤时,
            # 后一步必须在前一步的结果之上变换, 否则互相覆盖(实测踩过)
            current = read_file(s.relpath)
            backup = s.relpath.with_name(s.relpath.name + BACKUP_SUFFIX)
            if not backup.exists():  # 备份只写一次, 保留最初原始版
                backup.write_bytes(current.encode("utf-8"))
            write_file(s.relpath, s.transform(current))
        touched += 1
        print(f"[DONE] {s.name} → {s.relpath.name}")

    # ── Phase 3: 回读验证 ──
    print()
    bad = 0
    for s, _ in plan:
        if not s.relpath.exists():
            continue
        content = read_file(s.relpath)
        if not s.is_done(content):
            print(f"[FAIL] 回读验证未通过: {s.relpath} (步骤 {s.name})")
            bad += 1
    if bad:
        print(f"\n{bad} 处验证失败! 备份在原文件旁 {BACKUP_SUFFIX}, 可手工比对恢复。")
        return 1

    print(f"✅ 全部完成: {sum(1 for s, _ in plan)} 处改动已应用并验证。")
    print()
    print("后续手动事项:")
    print("  1. 快照内 MEOW_MODIFICATIONS.md 条目索引补记本次改动(人工确认后)")
    print("  2. MEOW 条目 4 (tool-session-query 搜索排除) 按其 5 文件明细手动重放")
    print("  3. pnpm run verify-persistence-catalog  (确认生成文件未被触碰)")
    print("  4. pnpm run build 全量构建 → start-meow.bat 重启 3081")
    print("  5. 验证: 打开一个含 dsh-femo/chat 的旧 Femo 会话, 历史应正常加载")
    if touched:
        print(f"  6. 备份位置: 原文件旁 *{BACKUP_SUFFIX} (回滚=改名还原)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
