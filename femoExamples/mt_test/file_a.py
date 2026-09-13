"""file_a.py — 两个整数相加的演示文件。"""

def add(a: int, b: int) -> int:
    """把两个整数 a、b 相加，返回其和。

    入参必须是 int 类型；bool 是 int 的子类但语义不同，同样不接受。
    否则抛出 TypeError 并给出清晰提示。
    """
    if not (type(a) is int and type(b) is int):
        # type(x) is int 严格要求类型恰好是 int 本身，
        # 同时拒绝 bool 与其他自定义 int 子类
        raise TypeError(
            f"add() 参数必须恰好是 int（不接受 bool 或其他 int 子类），"
            f"实际收到 a={a!r} ({type(a).__name__}), "
            f"b={b!r} ({type(b).__name__})"
        )
    return a + b


def main() -> None:
    result = add(2, 3)
    assert result == 5, f"期望 5，实际 {result}"
    print(result)


if __name__ == "__main__":
    main()
