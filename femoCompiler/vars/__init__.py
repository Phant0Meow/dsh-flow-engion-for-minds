# femoCompiler/vars/__init__.py
"""
femoCompiler.vars — FEMO 变量子系统（语言层，施工清单 v2 合流版）
================================================================
旧四件套（FEMO_merge/FEMO_tasks/FEMO_vars/FEMO_checkpoint，步骤 1 产物）已于
2026-09-04 移 mytrashbin（commit 6dc3960）——本包为变量子系统唯一实现。

模块映射（清单 §3 的 FEMO_* 命名 → 本包）：
- vars/model.py      ← FEMO_varmodel.py   声明模型 + ScopeTable + 路径模型
- vars/env.py        ← FEMO_env.py        TaskEnv / WorldStore / ForkRegistry
                                           / TaskLedger / VarFacade
- vars/evaluator.py  ← FEMO_eval.py       Evaluator 统一求值器
- vars/merge.py      ← FEMO_merge.py      N 方三方合并（MISSING≡base/保留 base）
- vars/checkpoint.py ← FEMO_checkpoint.py per-task 快照编解码 + 分支直启
- vars/join.py       ← FEMO_join.py       JoinCoordinator（签到/凑齐/掐尾）

依赖方向（单向无环）：merge ← env ← evaluator/join/checkpoint ←（接线）runtime；
model 被全部兄弟引用，自身零依赖。
"""
