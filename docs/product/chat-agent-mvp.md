# 通用 Chat Agent MVP

> 状态：当前实现
>
> 日期：2026-08-06

Chat Agent 是一个普通 Pi 工具使用 Agent。每个 Session 固定创建时的模型与 System Prompt，消息和 Agent Run records 保存在 Chat Session 历史中。

Agent 的初始 `cwd` 是 `<Electron userData>/repository/`。它通过普通 `read`、`bash`、`edit`、`write` 直接理解和维护：

- `knowledge/**/*.md`：全局 Knowledge；
- `artifacts/<artifact>/`：全局 Artifact；
- `runs/<run-id>/`：Agent 工作历史。

Chat 不再连接平行 SQLite Knowledge Store，也不安装 `search_knowledge`、`read_knowledge`、`upsert_knowledge` 写入协议；普通文件搜索、读取和编辑就是唯一事实层的访问方式。Shell 使用 Oyster 捆绑的标准 Git CLI。

Chat 仍拥有通用 Todo 与 `spawn_agent`。子 Agent 使用独立上下文，但继承相同 Repository 根、模型、System Prompt 和工具集合；父子 Run 关系进入 Session 的 Agent Run records。

当前 MVP 不为 Chat 自动创建 branch、commit、merge、rollback 或权限沙箱。Agent 根据任务和 Repository 当前状态选择普通文件/Git 操作。
