# Skill Symlink 注入 MVP

> 状态：当前用户级纵向实现规格
>
> 日期：2026-08-01
>
> Artifact 边界：[知识加工、Projection 与 Artifact](../architecture/knowledge-model-and-projection.md)
>
> 当前发现切片：[外部 Agent Skill 发现与浏览 MVP](skill-discovery-mvp.md)
>
> 生态依据：[主流 Coding Agent 的 Skill 发现与格式调研](../research/agent-skill-discovery-and-format.md)

## 1. 结论

Oyster 管理的一个 Skill 继续对应一个 Artifact。向其他 Agent 注入时，Oyster 不把 Artifact 根目录暴露为 Skill，也不复制或同步另一份 Skill 内容；它只把 Artifact 中固定的 `output/` 子目录通过目录 symlink 注册到目标 Agent 的 Skill 位置。

当前链路只有：

```text
Skill Artifact
  -> <artifact>/output/
  -> 目标 Agent Skill 根中的目录 symlink
  -> 目标 Agent 按自身原生机制发现 Skill
```

当前所有目标 Agent 共用同一个 `output/`。Oyster 不转换 frontmatter、不重排文件、不生成 Agent 专属格式，也不通过 Plugin、Hook、MCP 或运行时 Prompt 模拟 Skill。将来只有在真实兼容性问题证明有必要时，才考虑在 `output/` 下增加不同格式的子目录并修订绑定选择规则。

symlink 只提供文件系统引用，不提供权限隔离。当前 MVP 接受这一边界，不增加副本、只读镜像、锁、身份合并或双向同步。

## 2. 最小概念与身份

本设计只增加两个应用概念，不改变 Artifact Domain：

- **Skill Output**：Skill Artifact 根部固定的 `output/` 目录，是当前允许暴露给外部 Agent 的完整 Skill 内容；
- **Skill Binding**：目标 Agent 注册位置中的一个目录 symlink，指向某个 Skill Artifact 的 `output/`。

Skill Output 不是新的 Artifact、独立权威副本或构建缓存。它只是该 Artifact 内部被外部 Agent 消费的部分。Skill Binding 也不形成新的 Skill 身份或持久状态域；文件系统中的 symlink 本身就是当前绑定事实。

Artifact 的当前身份继续是 Repository 相对路径。Skill 不是第二套 Artifact ID 或核心类型，而是由 Skill 应用从文件系统结构派生的角色：有效 Artifact 根存在名为 `output` 的文件系统项时，即作为 Skill Artifact 展示；只有 `output/`、`SKILL.md` 和基础元数据通过检查时才处于可绑定状态。这样损坏的 Skill Output 仍能在 UI 中被看见和修复，而普通 Artifact 不需要保存 `isSkill`、manifest 或数据库记录。

外部发现、Oyster 纳管和绑定继续是不同动作：

```text
发现外部 Skill != 创建 Skill Artifact != 创建 Skill Binding
```

## 3. Artifact 目录约定

一个可注入的 Skill Artifact 采用以下最小布局：

```text
<Oyster Repository>/artifacts/
└── my-skill/
    ├── AGENTS.md
    ├── notes.md                 # 可选，仅供 Artifact 维护
    ├── source-materials/        # 可选，仅供 Artifact 维护
    └── output/
        ├── SKILL.md             # 当前通用 Skill 入口
        ├── scripts/             # 可选
        ├── references/          # 可选
        └── ...                  # 任意其他文件或目录
```

根 `AGENTS.md` 继续表达整个 Artifact 的持久 Attention，不属于外部 Skill 输出，也不会因绑定被目标 Agent 当作 Skill 根文件。Artifact 根下除 `output/` 外的笔记、原始材料和维护文件同样不会被注入。

`output/` 内部仍保持包容性，可以包含 Markdown、脚本、可执行文件、配置、资源和任意其他内容。保存和注入这些文件不表示 Oyster 执行、安装或信任它们。

这项约定不改变普通 Artifact 的有效性契约：一个一级目录是否是 Artifact，仍然只取决于根 `AGENTS.md`。缺少 `output` 的 Artifact 仍然是有效普通 Artifact；存在 `output` 但内容无效的目录仍是有效 Artifact，并作为不可绑定的 Skill Artifact 展示。`output` 是 Skill 应用的结构标记，不是所有 Artifact 的固定 Schema，也不引入 Artifact 类型字段或 manifest。

## 4. 当前输出兼容性边界

当前不做 Agent 专属格式适配。为了让同一输出目录能被首批目标 Agent 按共同的 Agent Skills 目录形式加载，创建绑定前只检查：

- `output/` 是 Artifact 内可读取的真实目录；
- `output/SKILL.md` 是可读取的普通文件；
- `SKILL.md` 提供可用于目标注册目录名称的有效 `name`，并满足当前通用格式所需的基础元数据。

检查失败只表示该 Artifact 目前不能通过通用 symlink 方案注入，不表示 Artifact 无效，也不会触发自动修复或格式转换。Oyster 不用 Artifact 目录名猜测 Skill 名称，不改写未知 frontmatter，也不丢弃 `output/` 中的未知文件。

当前 symlink 在目标 Agent Skill 根中使用 `SKILL.md` 声明的 `name` 作为目录项名称，并指向 `output/` 的绝对路径。例如：

```text
~/.claude/skills/my-skill -> <Oyster Repository>/artifacts/my-skill/output
```

逻辑注册目录名称与 Skill `name` 保持一致，而物理目标目录固定为 `output/`。

## 5. 绑定与解绑

完整关系中的一次绑定需要：

- Skill Artifact；
- 目标 Agent；
- 目标 scope；
- 当 scope 为项目级时，对应的项目目录。

目标 Agent Adapter 只负责解析该 Agent 在相应 scope 下的已知 Skill 注册根。内容始终来自同一个 `output/`，因此路径差异不构成格式适配。

首个实现切片只开放 Claude Code、Pi 和 Codex 的普通用户级 Skill 根；数据与服务边界保留 scope 语义，但项目级目录选择和 Binding UI 留给下一切片。当前不写入项目、admin、system、bundled、managed 或 Plugin cache 位置。绑定行为遵循以下规则：

1. 重新检查 Artifact、`output/` 和 `SKILL.md`；
2. 解析目标 Agent 的注册根与 Skill `name`；
3. 注册根不存在时，只创建该已知根所需的目录；
4. 目标目录项不存在时，创建指向 `output/` 绝对路径的目录 symlink；
5. 目标已经是指向同一 `output/` 的 symlink 时，视为幂等成功；
6. 目标存在其他文件、目录或不同 symlink 时，明确报告冲突，不覆盖、不合并也不重命名已有 Skill。

解绑时，Oyster 只在目标仍是指向预期 `output/` 的 symlink 时删除该 symlink。解绑不会删除 `output/`、Artifact、真实目录、其他 Agent 文件或未知链接目标，也不会递归删除注册根。

当前不建立绑定数据库或 manifest。Oyster 通过已知注册根中的 symlink 及其目标路径重建绑定状态。同一个 Skill Artifact 可以同时在多个 Agent 或 scope 中建立独立 symlink；这些链接都指向同一个 `output/`。

## 6. 变化与失效

`output/` 内容变化后，所有 symlink 自然读取同一当前文件，不需要 Oyster 复制或同步。目标 Agent 是否需要执行 reload 或重启，仍由该 Agent 自身的加载机制决定；本 MVP 不安装 Plugin，也不远程控制其他 Agent 会话。

以下变化按普通文件系统事实处理：

- symlink 被外部删除后，该绑定即不存在；
- `output/`、Artifact 被移动或重命名后，旧 symlink 可能失效，Oyster 明确显示失效并允许用户重新绑定；
- `SKILL.md` 的 `name` 改变后，原链接名称不会在后台自动迁移，用户需要显式解绑并重新绑定；
- 目标 Agent 或用户直接修改 `output/` 时，修改就是对当前 Artifact 内容的普通文件修改；MVP 不区分写入者，也不增加锁或冲突协议；
- Oyster 未运行时，已有 symlink 和 Skill 内容继续留在本机，目标 Agent 可以按自身规则读取。

这些行为与统一 Repository 中 Artifact 文件层的路径身份和高信任本机文件模型一致。symlink 不被描述为权限边界。

## 7. 最小 UI 与页面职责

Skills 页面是 Skill 专用应用界面，并明确分成两个视图：

- **Oyster 管理**：每个条目对应一个 Skill Artifact，展示输出、入口文档和 Binding，并提供绑定与解绑；
- **外部发现**：继续按 Agent 展示 `DiscoveredSkill` 注册事实，只提供预览和打开原始位置。

Oyster 管理视图只需要：

- 展示固定输出位置及其当前可绑定状态；
- 展示首批三个用户级目标 Agent；
- 创建绑定；
- 展示 Agent、scope、symlink 路径和当前状态；
- 解绑；
- 对格式无效、目标冲突、权限失败和失效 symlink 给出明确错误。

工作台只显示 Skill Artifact 标记、输出摘要和前往 Skills 页面的入口，不放置绑定管理控件。一个 Oyster Skill 在管理视图中出现一次，绑定后又可能在外部发现视图中按 Agent 出现多次；这是权威 Artifact 与外部注册事实的并列展示，不做身份合并。

不增加格式编辑器、映射编辑器、同步状态机、关系图、自动冲突修复或运行时 enabled 推断。发现结果不会因为路径相同或内容相似而自动转为 Skill Artifact 或 Skill Binding。

## 8. 安全边界

- symlink 目标固定为当前 Artifact 根下的 `output/`，Renderer 不能提交任意源路径；
- 目标位置只能由受支持 Agent Adapter 和 scope 解析，Renderer 不能提交任意目标绝对路径；
- 创建前使用 `lstat` 区分 symlink、真实目录和普通文件；
- 冲突目标永不覆盖；
- 解绑只对仍指向预期 `output/` 的单个 symlink 执行 unlink；
- Oyster 不读取或执行 `output/` 中的脚本和可执行文件；
- 操作继续使用 APP 当前 OS 用户权限，不提升权限，也不承诺隔离其他本地 Agent 的写访问。

若当前平台或文件系统无法创建目录 symlink，操作明确失败。MVP 不静默回退到复制、junction、Plugin 注入或其他安装机制。

## 9. 明确不做

当前设计不包括：

- 不同 Agent 的内容转换、专属 frontmatter 或目录布局；
- `output/` 下的 Adapter 选择、fallback 或构建规则；
- 把外部发现的 Skill 自动迁入 Artifact；
- Skill 内容复制、镜像、双向同步或三方合并；
- Plugin、Hook、MCP、Prompt 或内存 Skill Provider 注入；
- 自动 reload、重启或控制目标 Agent；
- Agent 侧 enabled 状态和调用情况观测；
- admin、system、bundled、managed 或 Plugin Skill 的修改；
- 权限隔离、只读挂载、锁、审批或写入者身份追踪；
- 云端 Agent 和跨设备分发。

未来若不同 Agent 的格式差异确实无法由同一个 `output/` 满足，可以在不改变 Skill Artifact 身份的前提下，于 `output/` 下增加不同内容目录，并让 Binding 选择其中一个目录作为 symlink 目标。具体目录名称、fallback、生成方式和迁移规则届时再设计，当前不预设。

## 10. 验收条件

实现本设计时至少验证：

- symlink 指向 `output/` 而不是 Artifact 根；
- 目标 Agent 原生加载的 Skill 根是 `output/`，Artifact 的 `AGENTS.md` 和维护材料不属于该 Skill 根；
- 同一个 `output/` 可以同时绑定到多个 Agent 注册根；
- 修改 `output/` 后不需要复制即可从所有绑定路径读取新内容；
- 相同绑定幂等，已有冲突目标不会被覆盖；
- 解绑只删除预期 symlink，不删除目标内容；
- Artifact、`output/`、`SKILL.md` 或链接失效时有明确状态；
- 普通 Artifact 不因缺少 `output/` 而变为无效；
- 测试只使用隔离临时目录，不修改开发机真实 Agent 配置。
