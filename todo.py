tasks = []

while True:
    print("\n===== Todo List =====")
    print("1. 添加任务")
    print("2. 查看任务")
    print("3. 退出")

    choice = input("请选择：")

    if choice == "1":
        task = input("输入任务：")
        tasks.append(task)

    elif choice == "2":
        for i, task in enumerate(tasks, start=1):
            print(i, task)

    elif choice == "3":
        break
