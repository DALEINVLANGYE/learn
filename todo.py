"""A small, in-memory command-line todo list."""


def main():
    tasks = []

    while True:
        print("\n1. 添加任务")
        print("2. 查看全部任务")
        print("3. 退出")

        try:
            choice = input("请选择操作 (1-3)：").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            return

        if choice == "1":
            try:
                task = input("请输入任务：").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n再见！")
                return

            if not task:
                print("任务不能为空。")
                continue

            tasks.append(task)
            print("任务已添加。")
        elif choice == "2":
            if not tasks:
                print("暂无任务。")
            else:
                print("全部任务：")
                for number, task in enumerate(tasks, start=1):
                    print(f"{number}. {task}")
        elif choice == "3":
            print("再见！")
            return
        else:
            print("无效选项，请输入 1、2 或 3。")


if __name__ == "__main__":
    main()
