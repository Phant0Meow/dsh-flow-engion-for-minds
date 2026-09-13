"""
# user_data/projects/function_test.py
— 延迟测试模块
用于验证数据库写入时序问题
"""
import time
import random

def wait_30():
    """等待 30 秒后返回"""
    print("[sleep_test] 💤 开始等待 30 秒...")
    time.sleep(30)
    print("[sleep_test] ⏰ 等待结束")
    
def wait_random():
    """等待 30 秒后返回"""
    t = random.randint(0,100)
    print(f"[sleep_test] 💤 开始等待 {t} 秒...")
    time.sleep(t)
    print("[sleep_test] ⏰ 等待结束")
    
def wait_10():
    """等待 30 秒后返回"""
    t = random.randint(0,10)
    print(f"[sleep_test] 💤 开始等待 {t} 秒...")
    time.sleep(t)
    print("[sleep_test] ⏰ 等待结束")


