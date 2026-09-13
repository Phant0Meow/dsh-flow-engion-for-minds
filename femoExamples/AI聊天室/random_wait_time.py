"""群聊室配套：随机发言间隔（模拟人类打字节奏）。"""

import random
import time


def random_interval():
    """每轮 AI 发言前随机等待 2~6 秒。"""
    time.sleep(random.uniform(2, 6))
    return 0
