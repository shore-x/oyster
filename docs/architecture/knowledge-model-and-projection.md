# 知识加工、Projection 与 Artifact

> 状态：当前架构；知识加工 Git 协作已实现 MVP
>
> 日期：2026-08-06
>
> 协作细节：[统一 Git Repository 与 Agent 协作](unified-git-agent-collaboration.md)

## 1. 三个权威域

系统区分三个语义域：

1. 观察层表达发生了什么；
2. 知识层表达目前可以怎样理解；
3. Artifact Domain 表达围绕 Attention 正在共同维护什么。

Raw Evidence 不因被模型读取而成为知识，Artifact 不因被接纳而自动成为知识，Knowledge 也不能覆盖重建全部 Artifact 状态。Knowledge 与 Artifact 可以共享同一个 Git tree 和 revision，但仍是两个不同文件层。

## 2. 观察层

Raw Evidence 是 Source Adapter 从外部 Harness 原始位置读取的确定版本。外部记录变化、失效或无法读取时必须明确失败，不能替换为相似记录。Raw Evidence 不进入 collaboration repository。

Canonical Activity 是从 Raw Evidence 确定性生成的可读活动视图。它保留 Session、Instruction、Message、Reasoning Summary、Tool Call/Result、Attachment、顺序和 Raw locator，不用 LLM 判断重要性、因果或真假。

确定性预处理可以删除或改写纯表示噪音：

- 合并完全重复的 Harness 镜像并保留所有 locator；
- 过滤正常 token/lifecycle 遥测；
- 以大小和哈希表示不可读加密 payload；
- 将 Base64 二进制改为 Attachment 元数据；
- 通过独立工具把支持的图片作为真正图片输入读取；
- 将未知记录保留为 opaque activity。

因此 Maintainer 默认扫描 Canonical Activity，只在需要精确核查时通过 `read_evidence` 回到原文。Skill hint 也只是 Raw Evidence 导航，不证明 Skill 已生效。

## 3. Knowledge Statement

Knowledge Statement 是知识层唯一的权威语义单位。一条 Statement 描述一个可独立检索的主体：

- `knowledge/**/*.md` 中一个文件保存一条 Statement；
- 第一个 H1 是 canonical title，剩余 Markdown 是正文；
- canonical title 使用专名、术语或自然名词短语，不用机械编号或整句命题代替主体；
- 正文解释范围、属性、约束、不确定性和关系；
- `[[canonical title]]` 或 `[[canonical title|local display text]]` 引用其他 Statement；
- canonical title 在一个 revision 的 Knowledge tree 中唯一；
- 文件路径只是 locator，不是 Statement 身份。

全文搜索、title 定位、反向引用、图、Embedding 和相似度都是绑定 commit OID 的可重建 Projection，不是第二份知识事实，也不写回 Repository。

## 4. Artifact 与 Attention

Artifact 是用户与 Agent 围绕持久 Attention 维护的任意文件产物。目标文件层是 `artifacts/<artifact>/`，根 `AGENTS.md` 表达 Attention，内部可以包含文档、代码、配置、脚本或资源。

Knowledge 保存可复用理解；Artifact 保存针对 Attention 的实际产物状态。一次现实修改可以在同一 commit 中同时更新二者，但 Artifact 内容不会自动回流为 Knowledge。

## 5. 文件工作状态

当前知识加工 MVP 使用 `.oyster/WORK.md` 作为 branch-local 工作状态。它既是单次 Maintainer 的清单，也是 Maintainer/Reviewer 的交接文件，不构成第四个权威域。

工作清单由 Harness 在初始 commit 中创建，Maintainer 更新 checkbox，Reviewer 请求修改时追加未完成项，Reviewer 批准时删除。它不进入最终 tree，但可能保留在协作分支历史中。通用 Todo 实现仍保留供其他 Agent 使用，Maintainer/Reviewer 不安装 Todo 工具。

## 6. Agent 协作

Maintainer 完整扫描绑定 revision 的 Canonical Activity 与附件、按 locator 回查必要原文、读取当前 Repository，并直接修改 Knowledge/Artifact 文件。它完成工作清单、解决全部 Review 标记、创建一个增量 commit 后结束。

Reviewer 只从消费者视角审阅精确 HEAD 和相对 base 的变化。它没有 Raw Evidence 或观察工具：

- 有问题时，在实际文件加入 `REVIEW` 标记，在工作清单增加未完成项并 commit；
- 通过时，删除工作清单并创建只包含该删除的批准 commit。

Harness 传递 revision、校验 handoff 并决定下一次运行。测试链路从不 merge `main`；未来 promotion 是独立产品动作。

## 7. 当前迁移边界

统一 Git 协作当前只覆盖知识加工 MVP。现有 Knowledge 浏览与 Chat 仍读取 SQLite production store，现有 Artifact 页面仍使用独立 Artifact Repository。它们没有被伪装成 collaboration repository 的 Projection，也不会由加工测试自动写入。

后续是否把用户可见 Knowledge/Artifact 全面迁移到统一 Repository，需要另行确认并完整迁移读取、索引、编辑和 promotion 边界；当前实现不维护双写或隐式同步。
