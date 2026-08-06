# Artifact 文件层 MVP

> 状态：当前实现
>
> 日期：2026-08-06

Artifact 是统一 Oyster Repository 中的全局文件层，不是独立 Repository：

```text
<Electron userData>/repository/artifacts/<artifact>/
├── AGENTS.md
└── ...
```

带可读取普通根 `AGENTS.md` 的一级真实目录是一个 Artifact；该文件保存持久 Attention，其他内部结构任意。目录名是当前 locator。隐藏目录、symlink 目录以及缺少普通根 `AGENTS.md` 的目录不成为 Artifact。

Artifact 页面直接扫描 `repository/artifacts/`，显示有效 Artifact 和无效目录；创建操作只建立目标目录与最小 `AGENTS.md`。打开 Repository 时打开统一根，打开 Artifact 时打开其实际目录。初始化和 Git Runtime 由统一 Repository 负责。

Skill Artifact 仍可在 Artifact 内使用真实 `output/` 和 `output/SKILL.md`，并由 Skill 页面派生注册视图。该约定不改变 Artifact 的通用文件语义。

Artifact 内容可以由用户、Chat Agent 或加工 Agent 直接修改，并能与 `knowledge/` 变化进入同一个 commit。Run 只引用这些路径，不建立 Artifact 副本或 symlink。
