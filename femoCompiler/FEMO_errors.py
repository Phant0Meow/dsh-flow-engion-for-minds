"""FEMO 错误四桶分类与分发（2026-08-18 模块化设计；2026-09-05 ErrorDispatcher 重构；
2026-09-07 增设 WARNING 桶）。

统一错误处理入口：新代码遇到错误先 `classify_error` 归桶，再按桶处理——
- FATAL：编译/语法/结构错、LLM 配置错（无 key/模型/URL）→ 剧本暂停/不启动，
  错误信息回主模型与用户（host 转戏外视角）；
- AGENT：执行者输出问题（赋值违规、格式错、LLM 临时失败限流/超时）→
  错误反馈给当前节点执行者，该轮输出不落库，重跑此节点；
- WARNING：出现了值得作者知道的事，但没有任何东西被拒绝——编译不阻断
  （校验器收集进 script.warnings，随 check/job_start 回执上浮宿主），
  运行不停止（notify_author{severity:'warning'}，作者知情后照常走）；
- TOLERANT：可忽略（格式类解析失败等）→ 走 resolve 回调或丢弃，连作者
  都不打扰——这是它与 WARNING 的分界线（WARNING 必须让作者知情）。

WARNING 与 AGENT 的分界线：AGENT 有实质的「拒绝+重试」行为（输出不落库、
反馈执行者、wait_key 计数），是节点级可恢复错误；WARNING 什么都不拒绝、
不重试，只是提示。「不停止运行」不等于 warning——否则 TOLERANT 也是
warning 了；分界看「有没有被拒绝的东西」。

2026-09-05 错误链路重构（施工清单 v4）：本模块新增 ErrorDispatcher——
三桶分发入口（绑定 FEMORunner）。职责=宪法口径：拼装报错信息（compose_message）
+ 按桶下发信号（node_retry / notify_author，NDJSON 事件交宿主翻译成对应
agent 框架的行为）+ 返回裁决（VERDICT_*）给 runtime 执行。重试循环留在
runtime（裁决⑤：Error 只负责单次裁决与发信号，不驱动重试）；终止剧本的
执行权在 runtime（raise → worker → flow_error）。计数以 wait_key 为键
（ai_<node>_<n> / human_<node>_<n>，par 并发各分支独立 key 天然隔离）。

调用约定：FEMORunner.handle_error 是引擎内统一处理入口（薄壳）；分类判定用
classify_error；异常类标注用 FEMOConfigError / FEMOTransientError；
AI/human 节点的赋值错误环直接调 ErrorDispatcher.dispatch（errors 通道）。
"""
from enum import Enum
from typing import Dict, List


class ErrorCategory(Enum):
    FATAL = 'fatal'
    AGENT = 'agent'
    WARNING = 'warning'
    TOLERANT = 'tolerant'


class FEMOConfigError(Exception):
    """LLM 配置错误（无 key/模型/URL/供应商等）→ FATAL：剧本无法继续，直接报错。"""


class FEMOTransientError(Exception):
    """LLM 临时失败（限流/超时/网络抖动）。

    语义归属（2026-09-05 错误链路重构注，施工清单 v4 §3.1）：直连模式 API
    兜底遗留——宿主后端模式下 API 请求错误的兜底重试由宿主请求层负责
    （agent/request-error 瀑布：内置 llm-retry 快层 + 插件 api-retry 慢层），
    compiler 全程无感。本异常永不进 AGENT 反馈信号，仅直连 llmBridge 分支
    可达；重试用尽走 runtime 的暂停分支（现状语义保留）。"""


class FEMOActorExecutionError(Exception):
    """宿主执行体最终失败（2026-09-07 B5 执行失败信号：子代理死亡/超时/API
    预算耗尽——宿主侧最终没拿到 AI 回答，显式上报而非伪装成空台词）。

    执行者已不在场：node_retry 无接收者（挂等 3600s）、同一 wait_key 重等
    亦无人应答——runtime 裁决：通知作者（复用 agent_giveup 三通道：错误面板/
    聊天窗）+ llm_output=None 走暂停分支（分支在节点挂起、断点保留，续跑=
    换新执行体重演）。信号协议：human_input 信箱里的
    {'__actor_failed__': True, kind, detail} 信封（桥命令 actor_failed）。"""

    def __init__(self, kind: str, detail: str = ''):
        self.kind = kind or 'executor_error'
        self.detail = detail or self.kind
        super().__init__(f"{self.kind}: {self.detail}")


def classify_error(error: Exception) -> ErrorCategory:
    """按异常类型归桶。兜底 FATAL（未知错误不静默）。

    执行者输出类错误（AI 赋值违规等）不在此分类——它们走
    _extract_ai_assignments 的 assign_errors 通道（AGENT 语义），
    不经过 handle_error。WARNING 也不在此分类——警告不是异常，
    是显式观察，产生点直接调 ErrorDispatcher.warn。"""
    if isinstance(error, FEMOTransientError):
        return ErrorCategory.AGENT
    # FEMOConfigError、编译类（SyntaxError/ValueError）、未知错误 → FATAL
    return ErrorCategory.FATAL


# ── 事件名常量（引擎 → 宿主 NDJSON 信号；宿主侧由其事件翻译层消费）──
AGENT_RETRY_EVENT = 'node_retry'
NOTIFY_AUTHOR_EVENT = 'notify_author'
NODE_SETTLED_EVENT = 'node_settled'

# ── verdict 常量（dispatch 返回值；runtime 据此执行：
#    retry=continue / exhausted=break 落盘 move on / fatal=raise / tolerant=忽略）──
VERDICT_FATAL = 'fatal'
VERDICT_RETRY = 'retry'
VERDICT_EXHAUSTED = 'exhausted'
VERDICT_TOLERANT = 'tolerant'
# WARNING 桶裁决（2026-09-07）：warn 不拒绝任何东西，runtime 拿到即 continue——
# 语义上与 VERDICT_TOLERANT 同向（都不阻断），但 verdict 值分开，调用方/日志
# 能区分「作者已被提示」（warn）与「静默丢弃」（tolerant）。
VERDICT_WARN = 'warn'

# ── target 两值：compiler 认识的执行者类型。'main' 不进信号——compiler 不认识
#    "主模型"概念（宪法备注 2），subagent/main 的区分由宿主侧停靠租约承载，
#    信号对任何 agent 框架同构。──
FEEDBACK_TARGET_AI = 'ai'
FEEDBACK_TARGET_HUMAN = 'human'


class ErrorDispatcher:
    """错误四桶分发入口（绑定 FEMORunner；每 run 一个，run_async 里 reset）。

    职责=宪法口径：拼装报错信息 + 按桶下发信号 + 返回裁决。
    重试循环留在 runtime（裁决⑤）；终止剧本的执行权在 runtime
    （raise → worker → flow_error）。本类只判定与发信号。

    计数以 wait_key 为键（wait_key 含自增 counter，par 并发各分支独立
    key——不用 node_id 键控：par 循环体各分支 node id 相同会互抢额度）。
    human 节点与 ai 节点走同一链路（裁决④：同一 Dispatcher / 同一信号 /
    同一计数；差别仅在翻译端——human 的"执行者"是人，宿主租约=显示提醒
    而非 steer 模型）。"""

    def __init__(self, runner):
        self._runner = runner
        self._retry_counts: Dict[str, int] = {}   # wait_key（缺省 node_id）→ 本 run 已发 node_retry 次数

    def reset(self) -> None:
        """每场清零（run_async 里与 _fork_errors=[] 同位置调用）。"""
        self._retry_counts = {}

    def compose_message(self, *, node_id, errors, bucket, attempt=None,
                        max_attempts=None, ai_name='', target=FEEDBACK_TARGET_AI) -> str:
        """报错信息单点拼装（分 target 文案）：
        target='ai'    : "剧本错误（{bucket}桶）@ 节点 {node}（{ai_name}）：{errors}（第 x/N 次反馈）"
        target='human' : "你的输入未被接受：{errors}。请修正后重新输入。"
        超限（attempt > max_attempts）时尾巴改为"按结束跳过/继续"——giveup 的
        notify_author 与重试的 node_retry 看到同一段话（单点拼装）。
        所有信号/面板/聊天窗/画布看到同一段话。"""
        err_text = '; '.join(str(e) for e in (errors or []))
        over_limit = (attempt is not None and max_attempts is not None
                      and attempt > max_attempts)
        if target == FEEDBACK_TARGET_HUMAN:
            base = f"你的输入未被接受：{err_text}。"
            if over_limit:
                return base + f"已重试 {max_attempts} 次仍未通过，本节点按结束继续。"
            return base + "请修正后重新输入。"
        bucket_name = bucket.value if bucket is not None else 'agent'
        who = f"@ 节点 {node_id}" + (f"（{ai_name}）" if ai_name else "")
        if over_limit:
            tail = f"（重试 {max_attempts} 次仍未通过，本节点按结束跳过）"
        elif attempt is not None and max_attempts is not None:
            tail = f"（第 {attempt}/{max_attempts} 次反馈）"
        else:
            tail = ""
        return f"剧本错误（{bucket_name}桶）{who}：{err_text}{tail}"

    def dispatch(self, error, node_id, *, errors=None, bucket=None, wait_key='',
                 ai_name='', max_retries=2, attempt=None,
                 target=FEEDBACK_TARGET_AI) -> str:
        """唯一分发入口。errors 优先（assign_errors/assign_err 列表），
        否则 [str(error)]。返回 VERDICT_* 常量。

        FATAL：emit notify_author{severity:'fatal', message=compose(...)} → VERDICT_FATAL
               （调用方 runtime 自己 raise；宿主对 fatal 仅 log，实际作者投递由
                紧随的 flow_error 三通道承担——宪法要求发信号 ✓，宿主防双份）
        AGENT：n = _retry_counts.get(wait_key or node_id, 0) + 1；写回
               n <= max_retries：
                   target='ai' 时 emit ai_retry{node_name, attempt, errors}（既有显示行）
                   emit node_retry{node_name, wait_key, ai_name, feedback=compose(...),
                                   error, attempt, max_attempts, target}（行为信号）
                   emit notify_author{severity:'agent_error', message=compose(...)}
                   （报错即通知作者——2026-09-05 猫猫实测修订：不再等重试用尽才通知。
                    原因=执行者看到报错后可能"聪明规避"（重试时干脆不写赋值语句），
                    节点以 ok 收场而作者永远收不到报错。通知与重试并行，作者每次
                    报错都第一时间知道；message 自带"第 x/N 次反馈"尾巴表达状态。）
                   返回 VERDICT_RETRY
               n > max_retries：
                   emit notify_author{severity:'agent_giveup', message=compose(...)}
                   返回 VERDICT_EXHAUSTED（runtime break → 落盘 move on）
        TOLERANT：log 忽略 → VERDICT_TOLERANT（现状无产生点，保留路由）
        WARNING：emit notify_author{severity:'warning', message} → VERDICT_WARN
                 （不拒绝、不重试、无计数；运行照常，作者知情。与 agent_error
                  的分界：agent_error 拒绝了本轮输出并触发重试。）"""
        if bucket is None:
            bucket = classify_error(error) if error is not None else ErrorCategory.AGENT
        errors_list: List[str] = (
            [str(e) for e in errors] if errors is not None
            else ([str(error)] if error is not None else [])
        )
        if bucket == ErrorCategory.FATAL:
            self._emit(NOTIFY_AUTHOR_EVENT, {
                'node_name': node_id,
                'ai_name': ai_name,
                'severity': 'fatal',
                'message': self.compose_message(
                    node_id=node_id, errors=errors_list, bucket=bucket,
                    ai_name=ai_name, target=FEEDBACK_TARGET_AI),
            })
            return VERDICT_FATAL
        if bucket == ErrorCategory.WARNING:
            self.warn('; '.join(errors_list), node_id=node_id, ai_name=ai_name)
            return VERDICT_WARN
        if bucket == ErrorCategory.TOLERANT:
            print(f"[errors]⚠️ TOLERANT 错误（忽略继续）: {'; '.join(errors_list)}")
            return VERDICT_TOLERANT
        # ── AGENT 桶：wait_key 键控计数（par 分支隔离）──
        key = wait_key or node_id
        n = self._retry_counts.get(key, 0) + 1
        self._retry_counts[key] = n
        message = self.compose_message(
            node_id=node_id, errors=errors_list, bucket=bucket,
            attempt=n, max_attempts=max_retries, ai_name=ai_name, target=target)
        if n <= max_retries:
            if target == FEEDBACK_TARGET_AI:
                # 既有显示行（投影窗 ⚠️）：ai 节点的重试显示由它承担，
                # node_retry 是行为信号，宿主不重复投影（防双份）。
                self._emit('ai_retry', {
                    'node_name': node_id,
                    'attempt': n,
                    'errors': errors_list,
                })
            self._emit(AGENT_RETRY_EVENT, {
                'node_name': node_id,
                'wait_key': wait_key,
                'ai_name': ai_name,
                'feedback': message,
                'error': errors_list,
                'attempt': n,
                'max_attempts': max_retries,
                'target': target,
            })
            # 报错即通知作者（2026-09-05 猫猫实测修订，与重试并行——不再等
            # 重试用尽：执行者可能"聪明规避"报错（重试时不再写赋值），节点
            # 以 ok 收场而作者永远蒙在鼓里。severity='agent_error' 与超限的
            # 'agent_giveup' 区分；宿主两值同走作者三通道（错误面板/聊天窗/
            # flow_done 汇总 steer），message 复用同一拼装（含"第 x/N 次反馈"
            # 状态尾巴）。
            self._emit(NOTIFY_AUTHOR_EVENT, {
                'node_name': node_id,
                'ai_name': ai_name,
                'severity': 'agent_error',
                'message': message,
            })
            return VERDICT_RETRY
        self._emit(NOTIFY_AUTHOR_EVENT, {
            'node_name': node_id,
            'ai_name': ai_name,
            'severity': 'agent_giveup',
            'message': message,
        })
        return VERDICT_EXHAUSTED

    def warn(self, message: str, node_id: str = '', ai_name: str = '') -> None:
        """WARNING 桶便捷入口（2026-09-07）：运行期「值得作者知道但不拒绝任何
        东西」的观察。与 dispatch 的差别——不需要 Exception/错误列表，没有
        重试计数，发完即返回（runtime 无需看裁决，照常走）。

        典型产生点：断点续跑变量补种/孤儿、流程在无出边处正常收尾、动作未
        定义跳过、for 迭代器不是列表空转——都是「能跑，但作者应当知情」。
        消息格式与 compose_message 分开：警告没有「第 x/N 次反馈」状态，
        也不叫「错误」——`剧本警告 @ 节点 X：...`。"""
        text = str(message or '').strip()
        if not text:
            return
        at = f" @ 节点 {node_id}" + (f"（{ai_name}）" if ai_name else "") if node_id else ""
        self._emit(NOTIFY_AUTHOR_EVENT, {
            'node_name': node_id,
            'ai_name': ai_name,
            'severity': 'warning',
            'message': f"剧本警告{at}：{text}",
        })

    def _emit(self, event_type: str, data: dict) -> None:
        self._runner._emit_event(event_type, data)


def build_dispatcher(runner) -> ErrorDispatcher:
    """显式构造点（FEMORunner.__init__ 一行调用；测试可注入假 runner）。"""
    return ErrorDispatcher(runner)
