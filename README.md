# Oyster

Oyster 是一个独立于 Agent Harness 的本地知识库维护中心。当前纵向切片已经覆盖 Claude Code、Pi、Codex 的会话 transcript 与人类指令发现、登记和按需读取，并可在物理隔离的 SQLite Knowledge Sandbox 中运行完整知识加工链路；Canonical Activity、正式知识生产、协作式投影和上下文供给仍待实现。

## 当前可用功能

- 主动探测 Claude Code、Pi、Codex 的默认目录、环境变量目录和 CLI 路径；
- 手工选择自定义历史目录；
- 有界读取 JSONL header，统计文件、会话、人类指令、字节数、时间范围和异常文件；
- 按各 Agent 的官方层级发现 `CLAUDE.md`、`AGENTS.md`、rules 和 system prompt files，明确排除 Agent 自动 memory；
- 登记外部记录的稳定身份、内部 locator 和轻量版本指纹，不复制聊天正文；
- 由 Source Adapter 从原始位置按需读取用户选中的单条记录，并拒绝已经变化或失效的版本；
- 展示扫描状态、来源统计和异常文件数；
- Codex `sessions` / `archived_sessions` 去重；
- 配置 Codex Coding Plan、OpenAI API 或自定义 OpenAI-compatible Connection，发现其可用模型，OAuth 与 API Key 凭据保存在系统 Keychain；
- 为知识加工的每个阶段独立选择 Connection、具体 Model 和模型支持的思考强度；
- 从可用外部 Session 的确定 revision 运行 Observation Preprocessor，分段发现带 Raw Evidence 位置的开放 Candidate 问题；
- 使用 Pi Agent Core 调查开放 Candidate Agenda、按需读取 Raw Evidence、增量维护 Contribution Draft，并在全部 Candidate 得到处置后提交 Knowledge Contribution；
- 在独立 SQLite Knowledge Sandbox 中按 canonical title 原子创建、覆盖并回读自由文本 Statement；
- 通过独立知识库页面搜索、浏览和清空当前持久 Knowledge Statement；
- 默认提供明确标记为 Sandbox 的完整链路测试，同时保留不提交 Knowledge Contribution 的高级阶段调试；
- Electron Renderer 与文件系统业务逻辑通过 typed preload API 隔离。

## 本地开发

需要 Node.js 22.19 或更新版本（Pi Agent Core 的运行要求）。

```bash
npm ci
npm run dev
```

`npm run dev` 会先检查 Electron npm 包对应的桌面端二进制。如果依赖安装时因为 `--ignore-scripts`、网络中断或缓存不完整而缺少 `node_modules/electron/path.txt`，启动脚本会自动执行 Electron 官方安装器进行修复。

如果二进制下载仍然失败，可以单独重试并查看完整错误：

```bash
npm run electron:ensure
```

Electron 二进制来自 GitHub Releases。需要代理的环境可设置 `ELECTRON_GET_USE_PROXY` 和系统代理变量；无法访问 GitHub 的环境可按 [Electron 官方安装说明](https://www.electronjs.org/docs/latest/tutorial/installation)配置 `ELECTRON_MIRROR`。这些变量只影响 Electron 二进制下载，不应提交个人代理地址到仓库。

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
  src/ui         共享 Button/Icon 组件、design tokens 与控件样式
src/preload      typed IPC bridge
src/main         Electron 生命周期和 IPC composition root
src/main/discovery
  adapters       各 Agent 的定位、header 解析、人类指令发现与原地读取
  discovery-service  扫描、catalog、版本校验与访问协调
  repository     可替换的状态持久化边界
  source-evidence-reader 外部 Raw Evidence 的原地只读访问边界
src/main/ai-backends
  Connection、Keychain、Coding Plan OAuth、模型目录与 OpenAI-compatible 调用
src/main/knowledge-processing
  默认 Prompt、临时 Workspace、Observation Preprocessor、Pi Agent Runtime 与完整链路编排
src/main/knowledge-store
  当前 SQLite Knowledge Store 验证实现、按 title 读写 Statement 与隔离 Sandbox
src/shared       Main / Preload / Renderer 共用契约
```

生产模式只把外部来源的 catalog 状态写入 Electron `userData/discovery-state.json`，不复制 Agent 历史正文。上游 Agent 目录始终只读；记录变化或消失后，已保存的出处身份继续存在，但原文可能无法再次展开。JSON repository 是当前 bootstrap 实现，接口已与业务层隔离，数据量验证后可以替换为 SQLite。

AI Connection 元数据和知识加工阶段的 Connection / Model 配置分别保存在 `userData/ai-connections.json` 与 `userData/knowledge-processing.json`；OAuth 与 API Key 凭据只保存在系统 Keychain。Observation Workspace 只存在于主进程内存中，Candidate Agenda 和 Contribution Draft 只存在于一次知识维护运行中。当前验证 Knowledge Store 位于 `userData/knowledge-store/knowledge.sqlite`；完整链路使用 `userData/knowledge-store/sandboxes/` 下的独立快照，失败或取消时立即丢弃，成功后可显式丢弃或通过重跑替换，且没有写回基线 Store 的入口。SQLite 是当前实现选择，不代表正式知识层的长期存储介质已经确定。

当前产品范围与设计边界见 [Product Brief](docs/product/product-brief.md)、[本地 Agent 发现与外部证据访问](docs/product/local-agent-discovery-mvp.md)、[AI Backend MVP](docs/product/ai-backends-mvp.md)、[知识加工验证 MVP](docs/product/knowledge-processing-mvp.md)和[知识加工与协作式投影](docs/architecture/knowledge-model-and-projection.md)。
