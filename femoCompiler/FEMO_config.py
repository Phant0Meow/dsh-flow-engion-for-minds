"""
FEMO_config.py — 全局运行时配置（单例）
=====================================
统一管理数据库路径等配置。
由 FEMO 解释器在解析 meta 后调用 set_db_path() 设置，
其他模块调用 get_db_path() 读取。

代码原则：所有代码不许写try静默兜底不报错，有错必须报错。
"""

import os

_db_path: str = ""


def set_db_path(path: str):
    """设置数据库文件路径（通常由解释器调用）"""
    global _db_path
    _db_path = path
    print(f"[config] 📁 数据库路径已设置为: {_db_path}")


def get_db_path() -> str:
    """获取数据库文件路径，未设置时返回默认值"""
    global _db_path
    if not _db_path:
        from femoBridges.getDir.get_dir import get_user_dir
        user_dir = get_user_dir()
        _db_path = os.path.join(user_dir, "user_data", "memory", "Chronica.wor")
        print(f"[config] ⚠️ 未设置数据库路径，使用默认值: {_db_path}")
    # 如果是相对路径，基于 user_dir 解析
    if not os.path.isabs(_db_path):
        from femoBridges.getDir.get_dir import get_user_dir
        _db_path = os.path.join(get_user_dir(), _db_path)
    return _db_path
