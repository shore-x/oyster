# Oyster

Oyster 是一个独立于 Agent Harness 的本地知识库维护中心。当前纵向切片先完成 Claude Code、Pi、Codex 的历史来源发现、统计和 Raw Evidence 导入；知识提取、搜索和上下文注入将在此基础上继续构建。

## 当前可用功能

- 主动探测 Claude Code、Pi、Codex 的默认目录、环境变量目录和 CLI 路径；
- 手工选择自定义历史目录；
- 有界读取 JSONL header，统计文件、会话、字节数、时间范围和异常文件；
- 只读导入原始历史，按 session fingerprint 跳过未变化的数据；
- 展示扫描、导入、取消、失败与恢复后的状态；
- Codex `sessions` / `archived_sessions` 去重；
- Electron Renderer 与文件系统业务逻辑通过 typed preload API 隔离。

## 本地开发

需要 Node.js 22 或更新版本。

```bash
npm install
npm run dev
```

验证命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:ui
```

`test:ui` 会启动固定数据模式的 Electron 窗口，将截图和语义快照写入 `artifacts/ui/`，然后自动退出。

## 代码边界

```text
src/renderer     页面、视图状态和用户动作
src/preload      typed IPC bridge
src/main         Electron 生命周期和 IPC composition root
src/main/discovery
  adapters       各 Agent 的定位与 header 解析
  discovery-service  扫描、统计、任务与幂等规则
  repository     可替换的状态持久化边界
  raw-evidence-store 原始文件的只读导入边界
src/shared       Main / Preload / Renderer 共用契约
```

生产模式把索引状态写入 Electron `userData/discovery-state.json`，把不可变原始副本写入 `userData/raw-evidence/`。上游 Agent 目录始终只读。JSON repository 是当前 bootstrap 实现，接口已与业务层隔离，数据量验证后可以替换为 SQLite。

产品范围与详细规则见[本地 Agent 发现与历史同步 MVP](docs/product/local-agent-discovery-mvp.md)和[发现/导入架构](docs/architecture/agent-discovery-and-history-import.md)。
