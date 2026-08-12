# Oyster Skill 与文件系统绑定

## 选择

一个由 Oyster 管理的 Skill 是根部同时包含 `AGENTS.md` 与 `SKILL.md` 的 Artifact。Artifact 根直接采用开放的 Agent Skills 目录格式，可以包含脚本、参考资料、模板、图片或其他附件。

选择根 `SKILL.md` 作为声明，是因为它已经表达明确的 Skill intent，并能被目标 Agent 原生理解。Oyster 不增加 `isSkill` 字段、专用 manifest 或额外输出包装层。

## Binding

Skill Binding 是目标 Agent 注册位置中的目录 symlink，直接指向 Skill Artifact 根：

```text
artifacts/my-skill/       目标 Agent 的 Skill 注册根/
├── AGENTS.md             └── my-skill -> artifacts/my-skill/
├── SKILL.md
└── ...
```

`AGENTS.md` 服务 Oyster 中的维护协作，`SKILL.md` 服务 Agent Skills 消费约定；目标 Agent 看到完整目录是有意选择，不建立需要同步的副本。symlink 是当前绑定事实，不另建 Binding 数据库。

绑定前需要确认 Artifact、根 `SKILL.md` 及其名称可被目标格式接受。目标已经存在其他文件、目录或不同链接时明确报告冲突，不覆盖或合并；解绑只删除仍指向预期 Artifact 的链接，不删除 Artifact 或其他 Agent 内容。

当前支持的注册位置和格式检查以 Agent Adapter 与测试为准。首个切片面向受支持 Agent 的用户级位置；项目级、管理员或系统位置不是当前写入范围。

## 设计边界

- 一个 Skill Artifact 可以同时绑定到多个 Agent；内容变化会通过同一目录自然可见，不需要同步状态机；
- 发现与绑定操作不执行 Skill 附带脚本，也不声称 symlink 是只读或权限边界；目标 Agent、Chat Agent 和用户仍可能在其他明确任务中读取或修改同一 Artifact；
- 外部发现与 Oyster 管理保持分离：看到外部 Skill 不会自动创建 Artifact，Binding 被外部发现也不会合并两种身份；
- Oyster 不自动转换不同 Agent 的 frontmatter、不控制目标 Agent reload，也不根据文件存在声称 Skill 已启用或被调用；
- 若未来真实兼容性证明同一标准目录不足，再为具体 Agent 设计适配，当前不预设多输出构建体系。
