"""斯坦福小镇配套：角色移动（同步 location 字典与地点数组）。

AI 已通过 `SET VARIABLE: <<@角色.location = "地点">>` 更新 location[actor]；
本函数把三个地点数组同步到与 location 一致（幂等，可重复调用）。
"""


def move(actor, location, 在酒馆的人, 在公园的人, 在市场的人):
    """从旧地点移除 actor，按 location[actor] 加入新地点。"""
    places = {"酒馆": 在酒馆的人, "公园": 在公园的人, "市场": 在市场的人}
    target = location.get(actor)
    # 从所有地点移除（幂等）
    for members in places.values():
        while actor in members:
            members.remove(actor)
    # 加入新地点
    if target in places and actor not in places[target]:
        places[target].append(actor)
    return {
        "location": location,
        "在酒馆的人": 在酒馆的人,
        "在公园的人": 在公园的人,
        "在市场的人": 在市场的人,
    }
