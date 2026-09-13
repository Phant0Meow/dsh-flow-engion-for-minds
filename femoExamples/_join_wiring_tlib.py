# python/_join_wiring_tlib.py
"""join 接线测试（test_v2_join_wiring.py）的外部 Python 函数——零 LLM 测试基建。

⚠️ 新增文件（非删除）；命名带 _join_wiring 前缀表明归属。
"""


def nine():
    """副本隔离测试：返回 999（write_a 经 out: hp.@a 路径写写入本 task 副本）。"""
    return 999


def echo(v=None):
    """透传：in: 的变量值原样返回（读侧断言用）。"""
    return v


def add(a=0, b=0):
    """两数相加（join 合并结果断言用：两分支各自的单方修改都应保留）。"""
    return a + b


def slow():
    """join(N) 掐尾测试：睡 1.5 秒——fast 分支签到凑齐时本分支必然还在睡，
    cancel 后 [SLOW2] 绝不该执行。"""
    import time
    time.sleep(1.5)
    return "slow-done"
