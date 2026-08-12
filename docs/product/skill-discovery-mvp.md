# 外部 Agent Skill 发现

## 目的

用户需要看清 Claude Code、Pi、Codex 等 Agent 在本机和已知外部工作目录中注册了哪些 Skill。发现只描述当前文件系统证据，不把外部 Skill 自动纳入 Oyster，也不声称某个 Skill 已启用、没有被同名项遮蔽或曾被调用。

一条发现结果保留 Agent、来源 scope、路径语境、Skill 目录和入口文档，足以让用户区分同名注册并查看原始内容。同名项不会跨 Agent、scope 或路径合并；结果可以从文件系统重建，不需要长期数据库。

## 为什么与 Artifact 分离

外部 Skill 的生命周期属于其他 Agent 或用户目录。发现它不等于创建由 Oyster 维护的 Artifact，也不等于建立 Skill Binding。只有用户明确与 Oyster Agent 协作创建或纳管内容时，才形成根部带 `AGENTS.md` 和 `SKILL.md` 的 Skill Artifact。

外部发现保持只读：按各 Agent 的已知规则扫描注册位置，按选择预览 `SKILL.md` 或兼容入口，并允许打开原始目录；不复制、修改或执行附带内容。

## 项目路径语境

Oyster 没有 Project Registry。当前项目级发现临时复用 Source Conversation catalog 中的 `projectPath`，因为它提供已经观察到的外部工作目录；该路径只是发现元数据，不建立 Oyster Project，也不会遍历整个 Home 猜测所有项目。

这是临时路径来源。未来启动自动探测和统一发现模块形成后，应让 Skill 发现消费更合适的已知目录集合，而不是长期依赖历史 Conversation catalog。

## 信任边界

发现只读取受支持 Agent 的已知位置和入口文档，不执行脚本或依赖。目录、格式、大小边界和不同 Agent 的兼容规则会随生态变化，由 Adapter、代码与测试维护。

静态文件存在只能证明“发现了候选注册”。Plugin、managed/bundled Skill、运行时动态目录、Workspace trust 和冲突解析可能使真实可用集合不同；UI 因此使用“已发现”，不使用“已启用”。
