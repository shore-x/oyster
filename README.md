# Oyster

Oyster 是一个本地优先、独立于具体 Agent Harness 的知识与协作产物中心。它帮助用户从分散的 Agent 活动中形成可长期维护的 Knowledge，并通过对话与 Agent 持续维护 Artifact。

## 本地开发

需要 Node.js 22.19 或更新版本。

```bash
npm ci
npm run dev
```

常用验证命令：

```bash
npm run typecheck
npm test
npm run build
```

`npm run test:ui` 用于运行 Electron UI smoke test。

## 设计文档

从 [设计文档索引](docs/README.md) 开始阅读。推荐的第一组入口是：

- [Product Brief](docs/product/product-brief.md)：产品问题、承诺与边界；
- [领域概念](docs/architecture/terminology.md)：Observation、Knowledge、Artifact、Task 等核心名词；
- [统一 Repository 与 Agent Git 协作](docs/architecture/unified-git-agent-collaboration.md)：Task、revision 与 worktree 的协作模型。

通用、稳定的设计判断原则见 [AGENTS.md](AGENTS.md)。精确实现和测试行为以代码与测试为准；若二者与设计不一致，应显式修订，不在入口文档中保留平行定义。
