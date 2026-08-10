# Knowledge、Artifact、Run 与 Projection

> 状态：当前架构
>
> 日期：2026-08-06

## 1. 四个边界

系统区分四类事实：

1. Observation 表达外部 Agent 实际发生了什么；
2. Knowledge 表达当前可复用的理解；
3. Artifact 表达围绕持久 Attention 维护的实际产物；
4. Run 表达 Agent 如何读取、修改、审阅并形成候选 revision。

Observation 位于外部来源边界。其余三类在一个 Oyster Repository 中分别使用 `knowledge/`、`artifacts/`、`runs/`。Run 是一级过程概念，但不拥有或复制另外两个事实层。

## 2. Knowledge

`knowledge/**/*.md` 中一个文件保存一条 Knowledge Statement：

- 第一个 H1 是 canonical title，剩余 Markdown 是自足正文；
- canonical title 在一个 revision 中唯一；
- `[[canonical title]]` 或 `[[canonical title|display text]]` 表达关系；
- 文件路径是 locator，不是 Statement 身份。

Knowledge 浏览器直接扫描这一文件层。全文搜索、邻域图和引用关系是可重建 Projection，不是第二份权威 Knowledge Store。

## 3. Artifact

`artifacts/<artifact>/` 保存一个 Artifact。其根 `AGENTS.md` 表达持久 Attention，其他文件结构任意。Artifact 内容不会仅因存在而自动成为 Knowledge；一次现实修改可以在同一个 commit 中同时更新两层。

## 4. Run

`runs/<run-id>/WORK.md` 是 Maintainer 与 Reviewer 共用的持久工作面，保存清单和角色明确的 handoff。终态 `run.json` 保存 Agent 轨迹与结果。Run 通过路径与 commit OID 引用输入和候选内容，不保存 Knowledge/Artifact 副本。

Run 文件不是候选内容 revision 的一部分，因此工作历史能够跨 Git branch 保留。

## 5. Observation

Raw Evidence 是 Source Adapter 从外部 Harness 原始位置读取的确定版本。Canonical Activity 是其确定性、可定位的对话优先语义投影：用户与 Assistant 消息以及上下文压缩形成的语义摘要保留完整正文；工具只保留操作身份并绑定调用与结果的 Raw locator，参数、结果、模型内部 reasoning、压缩记录中的 replacement history、重复传输事件、上下文快照和协议包装不进入默认正文。Codex 以 user role 记录的 AGENTS、环境、权限和运行模式信封同样不是用户对话。图片等附件从工具结果中独立提取，未进入投影的精确内容始终可由 locator 回查 Raw Evidence。Maintainer 默认扫描 Canonical Activity，只在需要精确核查时回到 Raw Evidence；两者都不因被读取而成为 Knowledge，也不复制进 Run。
