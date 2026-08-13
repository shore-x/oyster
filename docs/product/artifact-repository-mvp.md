# Artifact 与工作台

## 为什么使用文件目录

Artifact 是用户与 Agent 持续维护的实际产物。真实产物可能是文档、配置、代码、脚本、图片或完整工程；普通目录能够保留这种异构性，也能直接使用 Coding Agent、编辑器和 Git，而无需先设计 Artifact 类型体系或专用编辑器。

当前统一 Repository 的 `artifacts/` 下，每个带可读取根 `AGENTS.md` 的一级真实目录是一个 Artifact。目录名表达当前身份，其他内部结构由内容决定。隐藏目录、symlink 目录以及缺少根 `AGENTS.md` 的目录不被当作 Artifact。

选择 `AGENTS.md` 是为了复用 Coding Agent 生态已经理解的上下文约定。它以自然语言说明如何维护当前 Artifact；说明质量由用户与 Agent判断，不使用固定 Schema 作为有效性门槛。Agent Runtime 的 System Prompt 具有更高信任优先级，MVP 不为两者的潜在冲突增加治理层。

## 工作台

工作台是 Artifact 面向用户的浏览与未来维护界面。它读取同一正式文件，不拥有副本，也不引入 Project、Workspace、Artifact 类型或新的生命周期。

当前用户通过与 Chat Agent 对话表达需要长期维护的内容，由 Agent 创建和修改 Artifact。工作台不提供手动创建空目录的表单；未来模板也应帮助用户形成对话目标，而不是绕过 Agent 创建空壳。

文件浏览器提供底层、通用的检查方式。当前界面只读并不限制 Artifact 本身只能由 Agent 修改；普通编辑器、用户和其他获得授权的机制都可以维护相同文件。

## 与 Knowledge、Task 和 Skill 的关系

Artifact 内容不会仅因存在而成为 Knowledge。一次有意义的维护可以同时修改两者并进入同一 Git revision。

Knowledge Processing Task 在自己的 branch/worktree 中修改正式 Artifact，但不复制 Artifact 树。Task 中临时使用的 Maintainer、Reviewer 或 subagent 也不会变成 Artifact Domain 的固定角色。

Artifact 的目标不限于把经验转成 Skill。文档、配置、代码、模板、数据与其他可维护产物都可以由 Observation 中提炼的理解、现有 Knowledge 或用户目标驱动创建和修订。Skill 只是 Artifact 的一种实际用途，继续保持完整目录与普通 Artifact 规则；如何声明 Skill intent 以及如何绑定到外部 Agent，由[Skill 文件系统绑定](skill-symlink-injection-mvp.md)单独说明。

经 Knowledge Processing Task 创建或修订的 Artifact 与该 Task 共处 Git 历史，因此具备文件和变更集级审计；用户、普通编辑器或 Chat Agent 的其他修改只有普通 Git 历史。这不表示任意 Artifact 内部已经具有内容级 provenance。MVP 的正式内容级出处承诺首先面向 Knowledge Statement。具体 Artifact 若需要更细出处，应由其自身格式表达，避免为任意目录和二进制强加统一 Schema。

## 待验证的候选方向

工作台未来可能提供比文件浏览更贴近产物的内容视图。一个候选约定是：仅当 Artifact 根存在普通 `index.html` 时，工作台可在隔离环境中提供静态交互页面，并继续保留文件浏览器。

这不是当前实现或 Artifact 有效性契约。`index.html` 仍是普通文件，不建立新的 Artifact 类型或 manifest。页面可访问的本地资源、脚本、网络和持久化边界，需要通过真实用户场景验证后另行设计。
