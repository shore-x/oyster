# 跨 Agent Harness 轨迹投影调研

> 状态：非规范性研究记录。本文保存一手证据、比较和采纳建议，不定义当前产品行为；现行边界见[信息模型](../architecture/knowledge-model-and-projection.md)与[本地 Agent 来源发现](../product/local-agent-discovery-mvp.md)。
>
> 研究日期：2026-08-12

## 1. 研究问题与采用目标

本轮研究关注不同 Agent Harness 的原生轨迹如何被识别和投影，以及其中哪些成熟机制适合 Oyster。采用目标不是训练、RL、测试重试或在线可观测性，而是让 Maintainer 能从不同 Harness 的轨迹中可靠提取 Knowledge 并生产、维护 Artifact，同时保留核查依据。

成功标准是：相同语义在不同 Harness 中得到一致、可读的表达；任何投影结果都能回到被 Task 固定的证据范围；格式漂移和未知记录可被发现；Adapter 不替 Maintainer 做知识判断。反之，把 Runtime 注入当用户陈述、隐藏工具结果或错误、把分支物理顺序冒充执行路径、静默丢弃未知语义，或为兼容格式引入新的领域模型，都是本轮要避免的错误结果。

本轮以 Oyster 已有的最小数据流作为比较基线：

```text
原始来源
  → Raw Evidence（完整、固定、可定位）
  → Harness Adapter（确定性语义投影）
  → Canonical Activity（面向 Maintainer 的阅读视图）
```

Raw Evidence 和 Canonical Activity 是同一 Observation 的不同表示。外部方案中的 Span、Step、Memory Event 或 Observation Record 只是研究时的映射对象，不应因此成为 Oyster 的新领域概念。

## 2. 本地责任与采用落点

本轮复核以以下本地定义和实现 seam 为采用背景，而不把当前实现当作外部方案正确性的证据：

- [`model.ts`](../../src/main/observation/model.ts) 已用 `RawEvidence`、`CanonicalActivity` 和 `EvidenceRange` 表达完整 line view、可重建阅读投影及二者之间的定位关系；
- [`source-evidence-reader.ts`](../../src/main/discovery/source-evidence-reader.ts) 与 [`discovery-service.ts`](../../src/main/discovery/discovery-service.ts) 负责接受来源时的读取和版本固定；
- [`agent-observation-views.ts`](../../src/main/discovery/agent-observation-views.ts) 是 Harness 语义投影的本地落点；跨来源 fixture 和完整 range 的主要回归入口是 [`adapters.test.ts`](../../tests/adapters.test.ts)；
- [`task-input.ts`](../../src/main/knowledge-processing/task-input.ts) 负责把投影和 Raw locator 形成 Maintainer 可读取的普通 Task 文件；当前规范的物化合同是单个 `inputs/activity.md`、`inputs/evidence.txt` 和可选 `inputs/attachments/`；
- Maintainer 是读取证据、比较既有 Knowledge/Artifact 并直接维护 Repository 的普通 Agent。Adapter 只确定性解释原生轨迹，不新增 Extractor、Memory Manager 或 Integrator；Maintainer 在 `TASK.md` 的 `## Knowledge–Evidence` 中用自然语言记录实质 Knowledge 变更与 Evidence locator 的关系，而不增加独立 provenance 系统。Artifact 只保留 Task/Git 提供的变更集级审计。

因此，外部 decoder/Core 机制只映射到 Source Adapter 与 Canonical Activity 投影；外部 memory prompt 只用于校准 Maintainer 的关注点，不能反向改变 Raw Evidence、Task 或 Knowledge 的定义。

## 3. 证据复核与一手来源矩阵

2026-08-12 复核时，下列八个 pinned commit 均可通过 GitHub commit API 解析，本文直接引用的 pinned raw 源码、规范和研究 Prompt 均可读取。日期是被检查 revision 的提交日期，只表示本次证据快照的新鲜度，不表示项目成熟度。

| 来源 | 证据性质与权威性 | 固定 revision 日期 |
| --- | --- | --- |
| Letta `trajectory` | 官方实现与格式文档；Apache-2.0；版本 `0.2.5`，项目仍很新 | `59c0db5` · 2026-07-28 |
| Harbor ATIF | Harbor 仓库中的 Active RFC 和参考 Schema | `b7e2f71` · 2026-08-12 |
| OpenTelemetry GenAI | 官方 semantic conventions；相关字段多数仍为 Development | `8d3e4a0` · 2026-08-10 |
| OpenInference | 官方 specification 与配置约定 | `0b5a217` · 2026-08-12 |
| Langfuse | 产品实现、Observation model 与仓库 fixture；不是轨迹互换标准 | `33d797f` · 2026-08-12 |
| ReasoningBank | 论文配套研究代码；README 明确为 demonstration、非生产产品 | `ed80611` · 2026-05-19 |
| Hermes Agent | 官方 `/learn` 与 trajectory 保存实现 | `a3bcb2c` · 2026-08-12 |
| Mem0 | 官方 OSS memory 实现和 Prompt；需要以实际调用链区分当前与遗留 Prompt | `c427a45` · 2026-08-11 |

| 来源与固定版本 | 核心机制 | 对 Oyster 的适用边界 |
| --- | --- | --- |
| [Letta `trajectory` @ `59c0db5`](https://github.com/letta-ai/trajectory/tree/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32) | 支持 13 种 transcript source 和 DeepAgents checkpoint。每个 Adapter 先解码为最小的 `message`、`reasoning`、`tool_call`、`tool_result` 事件；共享 Core 再统一完成调用与结果配对、ID 修复、参数整形、边界处理、校验和 diagnostics。Canonical 输出另记录来源身份、顺序、组件索引、内容 hash 和 normalizer/schema version。主要定义见 [`internal.ts`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/src/internal.ts)、[`core.ts`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/src/core.ts)、[`canonical.ts`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/src/canonical.ts) 和 [`CANONICAL.md`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/CANONICAL.md)。 | 当前最适合作为 Adapter 行为参考和兼容性 differential oracle，而不是真值 oracle。公开 `CanonicalRecord` 虽包含归一化内容、工具字段和来源 identity/order/hash，但没有原始记录的可读 start/end range；部分生命周期记录被忽略；默认把工具结果截至 2500 Unicode code points、合成时间戳并保留 reasoning；[`pi-session-shared.ts`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/src/adapters/pi-session-shared.ts) 只按 JSONL message 行解码，没有解释 `parentId` 分支。项目仍较新，并存在恢复会话重复工具调用的[已知缺陷 #40](https://github.com/letta-ai/trajectory/issues/40)。 |
| [Harbor ATIF v1.7 @ `b7e2f71`](https://github.com/harbor-framework/harbor/blob/b7e2f71b4563618af3a42279740f5f412dcf7046/rfcs/0001-trajectory-format.md) | `system/user/agent` step 可携带 reasoning、多个 tool calls、按 `source_call_id` 配对的 observations、显式 context-management boundary，以及嵌入或外部引用的 subagent trajectory。 | 适合作为完整性检查表，特别是工具配对、compaction 和 subagent 结构。不应采用完整 Schema：Step 聚合、token、logprob、reward 和训练指标不属于 Oyster 的知识证据模型；其核心 Schema 也没有定义 Raw Evidence locator。 |
| [OpenTelemetry GenAI @ `8d3e4a0`](https://github.com/open-telemetry/semantic-conventions-genai/tree/8d3e4a0f3c34a46f6edb9c71e8666e02e6bf3958) | Ordered message parts 区分 text、tool call 和 tool response；`execute_tool` 支持来源可用的 call ID、name、arguments、result，并用 `error.type` 表达执行错误。正文采集默认 opt-in；没有原生或应用提供的 conversation ID 时不得自行伪造。见 [GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/8d3e4a0f3c34a46f6edb9c71e8666e02e6bf3958/docs/gen-ai/gen-ai-spans.md) 与 [registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/8d3e4a0f3c34a46f6edb9c71e8666e02e6bf3958/model/gen-ai/registry.yaml)。 | 可借鉴结构化 message parts、权威错误状态、不得伪造身份和显式敏感内容策略。不引入 OTel span、instrumentation 或遥测后端；这些约定大量仍是 Development，且在线观测与 Oyster 的离线证据接受场景不同。 |
| [OpenInference @ `0b5a217`](https://github.com/Arize-ai/openinference/tree/0b5a217696f79a3f2a51ec580f9c7f471efaa052/spec) | Tool call 保留 ID、name 和 arguments，结果用 `message.tool_call_id` 回链；ordered contents 可保留 text、reasoning、tool use 的相对顺序。主动遮盖使用 `__REDACTED__`，从而区别于缺失或空值。见 [`tool_calling.md`](https://github.com/Arize-ai/openinference/blob/0b5a217696f79a3f2a51ec580f9c7f471efaa052/spec/tool_calling.md) 和 [`configuration.md`](https://github.com/Arize-ai/openinference/blob/0b5a217696f79a3f2a51ec580f9c7f471efaa052/spec/configuration.md)。 | 可借鉴调用配对和显式 redaction marker。其超限 base64 image 外置仍为 Experimental，也不提供 uploader，不能据此引入通用 Blob 方案；Span taxonomy、Statement provenance 和原始文件 locator 同样不应从这里采用。 |
| [Langfuse @ `33d797f`](https://github.com/langfuse/langfuse/tree/33d797fa4cf0465ebf3d12f860b0d065828b2dd5) | [`ObservationSchema`](https://github.com/langfuse/langfuse/blob/33d797fa4cf0465ebf3d12f860b0d065828b2dd5/packages/shared/src/domain/observations.ts) 带 trace、parent、input/output、status 等在线观测字段；仓库保存多框架产生的[真实 trace fixtures](https://github.com/langfuse/langfuse/tree/33d797fa4cf0465ebf3d12f860b0d065828b2dd5/packages/shared/scripts/seeder/utils/framework-traces)。其 [README](https://github.com/langfuse/langfuse/blob/33d797fa4cf0465ebf3d12f860b0d065828b2dd5/packages/shared/scripts/seeder/utils/framework-traces/README.md) 说明基础导出先排除 input/output/metadata，但随后 [`merge-observations.ts`](https://github.com/langfuse/langfuse/blob/33d797fa4cf0465ebf3d12f860b0d065828b2dd5/packages/shared/scripts/seeder/utils/framework-traces/merge-observations.ts) 会把这些字段重新并入最终 fixture。 | 只借鉴“保存多框架真实结构样本”的兼容性回归思路。现有 fixture 经常含完整 input/output，不能当作隐私安全 corpus 模板；也不采用其 Observation Schema、数据库或分析后台。 |
| [ReasoningBank @ `ed80611`](https://github.com/google-research/reasoning-bank/tree/ed80611788292ea739f1effd31f16c53823b8a0d) | WebArena 的 [`induce_memory.py`](https://github.com/google-research/reasoning-bank/blob/ed80611788292ea739f1effd31f16c53823b8a0d/WebArena/induce_memory.py) 从 step pickle 中只提取 `<think>` 与 `<action>`，再附 success/failure 或 auto-eval 原因；抽取 Agent 关注成功原因或失败教训、可迁移性和去除任务字面量。输出 JSONL 仍保存 `task_id`、query、think/action 和 memory items。抽取指令见 [`memory_instruction.py`](https://github.com/google-research/reasoning-bank/blob/ed80611788292ea739f1effd31f16c53823b8a0d/WebArena/prompts/memory_instruction.py)。 | 适合作为“提炼 Agent 应关注什么”的参考，不适合作为预处理方案。它不把环境 observation 或工具结果提供给 memory LLM；虽保留 Task 级关联，也没有 memory item 到原始证据 span 的细粒度 provenance。它依赖 correctness signal，测试重试和 outcome memory 也不符合 Oyster 的产品形态。 |
| [Hermes Agent @ `a3bcb2c`](https://github.com/NousResearch/hermes-agent/tree/a3bcb2c23265dd6bc571fd7522ca4f6475c1b9a6) | [`/learn`](https://github.com/NousResearch/hermes-agent/blob/a3bcb2c23265dd6bc571fd7522ca4f6475c1b9a6/agent/learn_prompt.py) 把学习作为普通 Agent turn：读取用户指定的路径、URL、当前对话或笔记，先检查已有 Skill，再直接创建或扩展；大资料按章节增量维护 references。其 [`trajectory.py`](https://github.com/NousResearch/hermes-agent/blob/a3bcb2c23265dd6bc571fd7522ca4f6475c1b9a6/agent/trajectory.py) 只是 ShareGPT 格式落盘。 | 普通 Agent、普通文件、先检查既有 Artifact、按来源规模增量维护，很适合 Maintainer 的设计思路；其 trajectory 落盘不是跨 Harness Adapter，不能复用为 Oyster 预处理层。 |
| [Mem0 @ `c427a45`](https://github.com/mem0ai/mem0/tree/c427a453a89c5a3fee73cdb2e4c4df6a651e1692) | 输入已经是普通 chat messages。当前 [`main.py`](https://github.com/mem0ai/mem0/blob/c427a453a89c5a3fee73cdb2e4c4df6a651e1692/mem0/memory/main.py) 的 V3 主路径读取最近消息和相近既有 memory，再调用 [`ADDITIVE_EXTRACTION_PROMPT`](https://github.com/mem0ai/mem0/blob/c427a453a89c5a3fee73cdb2e4c4df6a651e1692/mem0/configs/prompts.py#L463-L475) 只产生 ADD 和可选既有 memory link；允许返回空列表。Agent scope 通过 `AGENT_CONTEXT_SUFFIX` 改变叙述视角。 | 可借鉴允许空提取、把新输入与近期上下文和既有内容一起判断。它不识别 Harness、工具轨迹或 Raw Evidence，不能作为 Adapter。`prompts.py` 中仍存在 user/assistant 隔离和 add/update/delete/none 的旧模板，但 pinned `main.py` 没有把它们作为当前 V3 主路径，不能据此描述现行机制。 |

## 4. Adapter 与提炼 Agent 的职责边界

外部证据支持把两类问题分开：

- **Adapter 回答“轨迹里可核查地发生了什么”**。它应是确定性的，关注角色、调用、结果、状态、分支、附件、噪声和 Raw locator，不判断什么值得成为 Knowledge。
- **Maintainer 回答“哪些内容值得维护，以及如何融入现有 Repository”**。Hermes 表明普通 Agent 可以使用普通工具完成来源收集、检查既有 Skill、创建或扩展和增量维护；在 Oyster 当前阶段，这足以支持不引入独立 distillation engine 的最小方案。
- ReasoningBank 的 memory LLM 关注成功/失败原因、行动性、可迁移性、去重和去任务字面量；这些是有用的策展检查项，但它的 correctness signal 和固定 memory-item 输出不能成为 Oyster 的前提。
- Mem0 当前路径提醒提炼 Agent允许输出为空，并在写入前读取近期上下文与相近既有内容；但其个人化 factual memory 数据模型不能映射成 Oyster Knowledge/Artifact 模型。

Oyster 的提炼 Agent 因而应优先核查证据、区分事实/推断/不确定性、检查已有正式内容、允许不修改，并按来源规模增量维护。它不应根据轨迹是否“成功”机械生产记忆，也不应把一次抽取结果视为不可修订的知识。

## 5. 可迁移的机制

### Borrow

- 每个 Harness 使用独立、结构容忍的 decoder，只负责解释原生格式；跨 Harness 一致的工具配对、校验和 diagnostics 放在共享逻辑中。
- Tool call 一致保留原生 ID、name 和结构化 arguments；tool result 使用原生 ID 回链，并保留正文及来源提供的成功、失败或未知状态。状态不得从结果文本猜测。
- 将来源身份、内容 hash 和阅读顺序分开；缺少原生身份时明确降低保证，不把内容 hash 伪装成原生会话或记录 ID。
- 未识别、被修复、被截断和被丢弃的输入都有稳定、可测试的分类；diagnostic 不泄露原始正文。
- 每种来源维护准确的输入契约、sanitized happy-path/cleanup fixtures、结构化 producer-version audit，以及隐私安全的真实 corpus 差分测试。Letta 的 [`add-source` prompt](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/prompts/add-source.md)、[`SOURCE_VERSION_AUDIT.md`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/SOURCE_VERSION_AUDIT.md) 和 [`PARITY.md`](https://github.com/letta-ai/trajectory/blob/59c0db52cc1521efc7fb5d8c7cccf48ee4afcf32/PARITY.md) 可作为工程流程模板；Langfuse fixture 只用于发现框架结构差异，不能替代脱敏流程。

### Adapt

- Letta 的最小内部事件集合可以作为 Adapter 实现参考，但 Oyster 的每项 Canonical Activity 必须继续携带完整 `EvidenceRange(start, end)`，让阅读投影可以回到 Raw Evidence。
- 对不认识的语义记录，Oyster 应默认生成带 Raw range 的 opaque Activity。只有能够证明是 transport noise 的记录才可丢弃，且每类 drop 都要有 fixture 和测试。
- 截断应按消息、参数、工具结果和二进制附件等语义分别处理。阅读面必须明确标记截断，并保留 Raw locator；不能把统一 head-tail 截断当成证据边界。
- Harness 的分支、compaction 和 subagent 信息只在确实影响“实际发生了什么”时投影。Pi 的 `id/parentId` 至少要保留原生父关系或明确 active/off-path，不能把 JSONL 物理顺序默认为单一执行路径。
- Reasoning 是否进入阅读面由 Oyster 的知识提取和安全边界决定；不能因为通用轨迹 Schema 包含 reasoning 就默认暴露。

### Reject

- 不直接采用 Letta 的公开 Canonical 输出作为 Oyster 的证据层，也不在当前阶段把它设为生产依赖。
- 不采用合成或插值 timestamp、强制完整轨迹必须同时有 user/assistant、默认保留 reasoning、默认工具结果截断，以及线性化 Pi 分支等行为。
- 不把 Harbor 的 Step、OTel/OpenInference 的 Span、Langfuse 的 Observation 或训练指标引入 Oyster 领域模型。
- 不采用 ReasoningBank 的测试重试、依赖 correctness signal 的成功/失败记忆，或只保留 think/action 的有损预处理。
- 不为格式兼容先增加通用 Workflow、Memory Event、Trace Store 或遥测后端。

## 6. Letta 的采用方式与方案比较

比较过三种采用方式：直接把 Letta 作为生产依赖会丢失 Oyster 的可读 Raw range 和证据保守策略；选择性移植 Adapter 代码在 Apache-2.0 下可行，但会立刻承担上游演进和本地分叉成本；保持本地模型并把 Letta 用作差分参照，不改变领域接口，最适合当前阶段。

因此当前推荐把 Letta `trajectory` 当作兼容性 differential oracle，而不是真值实现：

1. 同一组 Claude Code、Codex 和 Pi sanitized fixtures 同时运行 Oyster 与 Letta；
2. 比较角色、原生顺序、tool name、arguments、result、状态和 drop diagnostics；
3. 将 Raw range、opaque fallback、hidden-reasoning policy 和 Pi branch 处理记录为 Oyster 的有意差异；
4. Letta 行为变化时先通过差分测试审查，不自动同步。

若未来考虑直接依赖，最低前提是其每条 decoded event 能暴露真实 source anchor/range，且 Oyster 仍拥有 Raw Evidence、opaque fallback、敏感内容和 reasoning policy。否则依赖会削弱而不是增强 provenance。

## 7. 验证重点

- Claude Code：Runtime injection、sidechain、恢复会话重复记录、tool error 和未知语义 block；
- Codex：普通与 custom tool 的 arguments/result、失败状态、未知 `response_item`/`event_msg`、subagent failure；
- Pi：`toolResult` 角色与 `isError`、`id/parentId` 分支、compaction、custom/lifecycle entry；
- 所有来源：malformed JSON、空或不完整轨迹、orphan/duplicate tool result、超长参数与结果、opaque fallback、完整 Raw range；
- 真实 corpus：只输出结构签名、数量、hash 和 diagnostic 聚合；不打印或提交 transcript 正文、参数、结果、凭据、个人路径或标识符。

## 8. 事实、推断与仍待证据的问题

- **已验证事实**：上述 pinned 源码和规范定义了各自的字段、调用链和 drop/repair 行为；Letta Pi decoder 未读取 `parentId`；Langfuse merge script 会重新并入 input/output/metadata；Mem0 pinned 主路径使用 ADD-only V3 Prompt。
- **本地推断**：完整 range、opaque fallback、分支表达和来源权威错误状态共同构成 Oyster 比通用训练/遥测格式更严格的证据边界。这是依据产品目标作出的迁移判断，不是外部项目证明的结论。
- **建议**：保持当前领域模型、让 Adapter 确定性投影、让普通 Maintainer 负责策展，并将 Letta 限定为兼容性差分参照。

- Pi Session 在不同版本中的 active leaf 选择和分支恢复规则，需要结合原生实现与真实 fixture 继续确认；Letta 当前 decoder 没有解决该问题。
- 长轨迹中哪些 Canonical Activity 信息最影响 Knowledge/Artifact 提取质量，需要用 Oyster 自己的提取 eval 判断，不能由训练或可观测性 Schema 代替。
- Raw Evidence 的敏感内容、附件大小、删除和 Repository 传播策略属于产品数据治理问题；外部 Adapter 项目只能提供参考，不能替 Oyster 决定。
