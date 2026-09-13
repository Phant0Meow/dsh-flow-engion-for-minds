# femoCompiler/femoAsync.py
"""
多 Agent 并发引擎 - asyncio 版本
提供: 协程任务管理, 进程池(CPU 密集), 线程池(快速/兜底), 人类输入异步等待

接口说明:
- run_in_process(func, *args, **kwargs): 强制使用进程池执行（默认所有 @func 走这里）
- run_in_thread(func, *args, **kwargs):  强制使用线程池执行
- run_func(func, *args, mode='process', **kwargs): 通用入口，根据 mode 路由
- create_task(coro): 创建协程任务（用于 fork 分支）
- gather_with_cancel(tasks, return_when='all', count=1): 等待多个协程任务
- human_input.wait_for_input(key, timeout): 异步等待人类输入
"""

import asyncio
# 在 import asyncio 下方添加（如果有需要的话，但 FEMO_runtime 会导入这个）
CancelledError = asyncio.CancelledError
import os
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import Any, Callable, Coroutine, Dict, Optional, Set
import contextvars

# 每个工作流实例独立的上下文变量
workflow_ctx = contextvars.ContextVar('workflow_ctx', default=None)


class WorkflowContext:
    """工作流上下文，存储当前状态、取消事件等"""
    def __init__(self, name: str):
        self.name = name
        self.cancelled = asyncio.Event()
        self.locals: Dict[str, Any] = {}
        self.current_node_id: str = ""


class HumanInputManager:
    """管理多个等待点的人类输入事件（线程安全）。

    Job 模型增补（运行状态链路重构，施工清单 v3 §5.1）：
    - ``_aborted``：机制性停止识别（v1 吸收）——stop 流程置位后，所有现在与
      未来的 wait_for_input 调用点统一在恢复点 raise CancelledError，不靠人工
      逐点核对调用方。CancelledError 继承 BaseException（Python 3.8+），
      ``except Exception`` 不会误接成正常返回——branch_main / run_async 的既有
      ``except CancelledError`` 自然接住（分支安静退场/主流程走 suspended），
      零新增异常类型、零新增传播规则。
    - ``abort_all``（A2 方案 A）：stop 时对全部 executor 等待者 set 唤醒——
      worker 秒退不占锁（旧世界 cancel 打不进 executor，挂满 3600s 超时占死
      bridge 单跑锁）。
    - ``discard_all``：任何"Runner 就绪开跑"时刻信箱必须从零开始（attach 调用，
      幂等保险；清的是无主滞留信）。
    - ``provide_input`` 不变（仍先存 _data 再 set——孤儿信清理不在 provide 侧）。
    """

    def __init__(self):
        import threading
        self._events: Dict[str, threading.Event] = {}
        self._data: Dict[str, str] = {}
        self._lock = threading.Lock()
        self._aborted = False

    async def wait_for_input(self, key: str, timeout: float = None):
        import threading
        print(f"[AsyncEngine] 👤 等待人类输入 (专属频道: {key})")

        # 快速路径：provide_input 可能已经先到了（前端响应极快时）
        with self._lock:
            if self._aborted:
                # 机制性停止识别：job 已停止，等待点在入口即退出（不上 executor）
                raise CancelledError("job stopped")
            if key in self._data:
                print(f"[AsyncEngine] 📩 人类输入已抢先到达 (key={key})")
                return self._data.pop(key, "")

        event = threading.Event()
        with self._lock:
            # double-check：注册 event 前再检查一次，防止 provide_input 在上锁间隙到达
            if self._aborted:
                raise CancelledError("job stopped")
            if key in self._data:
                print(f"[AsyncEngine] 📩 人类输入在注册 event 时已到达 (key={key})")
                return self._data.pop(key, "")
            self._events[key] = event

        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, event.wait, timeout)
            # executor 唤醒后的取数路径：先查 _aborted（abort_all 唤醒的等待者
            # 在此恢复点直接吃 CancelledError 零推进，不会拿着空值继续演）
            with self._lock:
                if self._aborted:
                    raise CancelledError("job stopped")
                return self._data.pop(key, "")
        finally:
            with self._lock:
                self._events.pop(key, None)

    def provide_input(self, key: str, data):
        with self._lock:
            self._data[key] = data
            event = self._events.get(key)
        if event:
            event.set()

    def abort_all(self) -> None:
        """唤醒所有 cancel 漏网的 executor 等待者（A2，stop 链 ⑤——先 cancel 后
        abort 的顺序红线由 FEMORunner.stop 保证）。锁内置 _aborted 并收集全部
        event，锁外逐个 set()——唤醒的等待者在 wait_for_input 取数路径的
        _aborted 检查处 raise CancelledError。"""
        with self._lock:
            self._aborted = True
            events = list(self._events.values())
        for event in events:
            event.set()

    def discard_all(self) -> None:
        """信箱从零开始（JobManager.attach 在"Runner 就绪开跑"时刻调用，幂等）：
        清无主滞留信——宿主晚到投递把旧 wait_key 数据投进活跃新 manager 的
        污染路径，由 run_tag 世代前缀机制性免疫（§5.6），本清空是同 Runner
        生命周期内的保险层。"""
        with self._lock:
            self._data.clear()


class AsyncEngine:
    def __init__(self, cpu_workers: int = None, thread_workers: int = 10):
        import threading
        print("[AsyncEngine] 初始化引擎...")
        cpu_workers = cpu_workers or os.cpu_count() or 4
        self.process_pool = ProcessPoolExecutor(max_workers=cpu_workers)
        self.thread_pool = ThreadPoolExecutor(max_workers=thread_workers)
        self.human_input = HumanInputManager()
        self._active_tasks: Set[asyncio.Task] = set()
        # ── LLM 速率控制 (按 source 分组) ──
        # （D 收尾 2026-09-05：此处原有一段字面重复赋值（_active_tasks/llm_delay/
        # _throttle_locks/_last_call_time/_throttle_meta_lock 各重复一遍）——同
        # 名同值幂等覆盖、__init__ 期无并发窗口，删除重复段零行为变化。）
        self.llm_delay: float = 0.0
        self._throttle_locks: Dict[str, asyncio.Lock] = {}
        self._last_call_time: Dict[str, float] = {}
        self._throttle_meta_lock = threading.Lock()
        
        
        
    def is_event_loop_running(self) -> bool:
        """检查当前线程是否已有运行中的事件循环"""
        try:
            asyncio.get_running_loop()
            return True
        except RuntimeError:
            return False

    def run_async_until_complete(self, coro):
        """根据环境自动选择 asyncio.run 或直接 await（由调用方负责）"""
        if self.is_event_loop_running():
            raise RuntimeError("不能在已有事件循环中调用 run_async_until_complete，请使用 await coro")
        return asyncio.run(coro)

    def check_cancel(self):
        """检查当前协程是否被取消，若取消则抛出 CancelledError"""
        task = asyncio.current_task()
        if task and task.cancelled():
            raise asyncio.CancelledError("任务被取消")

    def get_running_loop(self):
        """返回当前事件循环，供需要直接操作 loop 的场景使用"""
        return asyncio.get_running_loop()

    def schedule_threadsafe(self, callback, *args):
        """线程安全地将回调调度到事件循环中执行"""
        self.get_running_loop().call_soon_threadsafe(callback, *args)

    async def gather(self, *coros, return_exceptions=True):
        """封装 asyncio.gather，方便分支等待"""
        return await asyncio.gather(*coros, return_exceptions=return_exceptions)

    async def run_in_process(self, func: Callable, *args, **kwargs) -> Any:
        """CPU 密集任务：自动排队到进程池"""
        print(f"[AsyncEngine] 🧠 分配 CPU 密集任务到进程池 (func={getattr(func, '__name__', func)})")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.process_pool, func, *args, **kwargs)

    async def run_in_thread(self, func: Callable, *args, **kwargs) -> Any:
        """
        将快速函数或同步 I/O 提交到线程池。
        为每次调用创建独立的事件循环，确保函数内部能正常使用 asyncio。
        """
        from functools import partial
        print(f"[AsyncEngine] 🧵 分配同步 I/O 或 AI 调用到线程池 (func={getattr(func, '__name__', func)})")

        def _wrapper(*a, **kw):
            import asyncio
            async def _runner():
                return func(*a, **kw)
            return asyncio.run(_runner())

        loop = asyncio.get_running_loop()
        if kwargs:
            wrapped = partial(_wrapper, *args, **kwargs)
            return await loop.run_in_executor(self.thread_pool, wrapped)
        else:
            return await loop.run_in_executor(self.thread_pool, _wrapper, *args)

    async def run_func(self, func: Callable, *args, mode: str = 'process', **kwargs) -> Any:
        """
        通用执行入口，支持后续扩展自动判断。
        目前 mode 默认为 'process'，即所有 @func 先走进程池。
        未来可根据用户标注或自动检测切换到 'thread'。
        """
        if mode == 'process':
            return await self.run_in_process(func, *args, **kwargs)
        elif mode == 'thread':
            return await self.run_in_thread(func, *args, **kwargs)
        else:
            raise ValueError(f"Unknown execution mode: {mode}")

    def create_task(self, coro: Coroutine) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._active_tasks.add(task)
        task.add_done_callback(self._active_tasks.discard)
        return task

    async def gather_with_cancel(self, tasks: list, return_when: str = 'all',
                                 count: int = 1) -> list:
        if not tasks:
            return []
        if return_when == 'all':
            return await asyncio.gather(*tasks, return_exceptions=True)

        pending = set(tasks)
        required = 1 if return_when == 'any' else int(count)
        finished_results = {}
        while pending and len(finished_results) < required:
            done, pending = await asyncio.wait(
                pending, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                idx = tasks.index(task)
                try:
                    finished_results[idx] = task.result()
                except asyncio.CancelledError:
                    finished_results[idx] = None
                except Exception as e:
                    finished_results[idx] = e

        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

        # 按原顺序排列结果
        final = [None] * len(tasks)
        for idx, val in finished_results.items():
            final[idx] = val
        return final

    async def throttle_llm(self, resource: str, delay: float = None):
        """
        确保对同一 resource 的连续调用至少间隔 delay 秒。
        若 delay 为 None，使用 self.llm_delay。delay <= 0 则不限流。
        """
        if delay is None:
            delay = self.llm_delay
        if delay <= 0:
            return

        # 获取或创建 resource 专用锁
        with self._throttle_meta_lock:
            if resource not in self._throttle_locks:
                self._throttle_locks[resource] = asyncio.Lock()
            lock = self._throttle_locks[resource]

        async with lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            last = self._last_call_time.get(resource, 0.0)
            wait_time = delay - (now - last)
            if wait_time > 0:
                await asyncio.sleep(wait_time)
            self._last_call_time[resource] = loop.time()

    async def shutdown(self):
        for task in list(self._active_tasks):
            task.cancel()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks, return_exceptions=True)
        self.process_pool.shutdown(wait=True)
        self.thread_pool.shutdown(wait=True)


# ============================================================
# 测试辅助函数（必须定义在顶层以便 pickle）
# ============================================================
def _heavy_computation(n):
    """纯 CPU 密集函数，用于测试进程池"""
    total = 0
    for i in range(n):
        total += i * i
    return total


# ============================================================
# 测试用例
# ============================================================
async def _test_cpu_task():
    engine = AsyncEngine()
    print("Testing CPU task via process pool...")
    result = await engine.run_in_process(_heavy_computation, 10_000_000)
    print(f"CPU task result: {result}")

    # 测试并发排队
    tasks = [engine.run_in_process(_heavy_computation, 5_000_000) for _ in range(10)]
    results = await asyncio.gather(*tasks)
    print(f"10 concurrent CPU tasks completed, sample: {results[:3]}")
    await engine.shutdown()


async def _test_fork_join():
    engine = AsyncEngine()

    async def branch(name, sleep_time):
        try:
            await asyncio.sleep(sleep_time)
            print(f"Branch {name} finished")
            return f"{name}_result"
        except asyncio.CancelledError:
            print(f"Branch {name} cancelled")
            raise

    print("\n=== Test gather all ===")
    t1 = engine.create_task(branch("A", 1))
    t2 = engine.create_task(branch("B", 1.5))
    results = await engine.gather_with_cancel([t1, t2], return_when='all')
    print("All results:", results)

    print("\n=== Test any (cancel others) ===")
    t3 = engine.create_task(branch("C", 2))
    t4 = engine.create_task(branch("D", 0.5))
    results = await engine.gather_with_cancel([t3, t4], return_when='any')
    print("Any results:", results)

    print("\n=== Test n=1 ===")
    t5 = engine.create_task(branch("E", 1.5))
    t6 = engine.create_task(branch("F", 0.8))
    t7 = engine.create_task(branch("G", 2))
    results = await engine.gather_with_cancel([t5, t6, t7], return_when='n', count=1)
    print("N=1 results:", results)

    await engine.shutdown()


async def _test_human_input():
    engine = AsyncEngine()

    async def wait_human(key):
        print(f"[{key}] Waiting for human input...")
        data = await engine.human_input.wait_for_input(key)
        print(f"[{key}] Received: {data}")
        return data

    t1 = engine.create_task(wait_human("user1"))
    t2 = engine.create_task(wait_human("user2"))

    async def provider():
        await asyncio.sleep(1)
        engine.human_input.provide_input("user1", "Hello from user1")
        await asyncio.sleep(0.5)
        engine.human_input.provide_input("user2", "Hi from user2")

    p = asyncio.create_task(provider())
    results = await asyncio.gather(t1, t2, p)
    print("Human input results:", results[:2])
    await engine.shutdown()


async def _test_context_vars():
    ctx_var = contextvars.ContextVar('test_key', default='default')

    async def worker(name, val):
        ctx_var.set(val)
        await asyncio.sleep(0.1)
        return f"{name}: {ctx_var.get()}"

    engine = AsyncEngine()
    t1 = engine.create_task(worker("A", "value_A"))
    t2 = engine.create_task(worker("B", "value_B"))
    results = await asyncio.gather(t1, t2)
    print("Context var isolation:", results)
    await engine.shutdown()


def main():
    async def run_all():
        await _test_cpu_task()
        await _test_fork_join()
        await _test_human_input()
        await _test_context_vars()
        print("\nAll tests completed.")
    asyncio.run(run_all())


if __name__ == "__main__":
    main()
