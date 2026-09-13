"""file_b.py — 正常的对照文件。"""

def double(x: int) -> int:
    """把一个数翻倍。"""
    return x * 2


def main() -> None:
    print(double(4))  # 期望输出 8


if __name__ == "__main__":
    main()
