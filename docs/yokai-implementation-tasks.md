# Yokai 可验收实施任务

状态：Draft 0.3

依据：[`yokai-design.md`](./yokai-design.md)

首发 adapter：`@yokai/koishi-plugin-yokai-adapter-gemini`

Gemini 客户端：Google 官方 `@google/genai`

## 1. 拆分原则

- 每个任务只交付一个协议、纯逻辑、持久化能力、adapter 能力或端到端行为。
- 任务只依赖“前置”栏中列出的任务；前置完成后，该任务可单独开发、评审和验收。
- 除端到端任务外，验收不依赖真实 Gemini 账号或真实群聊，使用可控的 Layer、HTTP 模拟和 Koishi 测试实例。
- 所有任务都必须通过 `yarn build` 和 `yarn lint`；时间相关测试使用 `TestClock`，不等待真实时间。
- 应用逻辑使用 Effect，`Effect.run*` 只能出现在 Koishi 边界和测试基础设施。
- `@google/genai` 只存在于 Gemini adapter 工作区；所有 SDK Promise、流和错误都在 adapter 边界转换为 Effect 和 `@yokai/protocol` 类型。
- 模型选择只存在主插件配置；adapter 仅发布模型快照，不保存 primary 或 fallback。

## 2. 优先交付：Gemini adapter

### YK-001 工作区与测试基线

前置：无。

交付：创建 `protocol`、`core`、`mind`、`memory` 和 `yokai-adapter-gemini` 工作区骨架，配置统一的单元测试入口。

验收：

- 每个工作区可独立类型检查，根工作区能构建全部包。
- 每个导入 Effect 的工作区都精确声明 `effect@4.0.0-rc.110`。
- Gemini adapter 声明官方 `@google/genai` 依赖和 `node >= 20` 运行时基线；其他工作区不引入该 SDK。
- 包名、依赖方向和输出目录符合设计文档，没有 Koishi 依赖泄漏到内部包。

### YK-002 通用 adapter 协议

前置：YK-001。

交付：在 `@yokai/protocol` 定义稳定 ID、协议版本、`<adapterId>/<modelId>` 模型引用、统一生成请求/结果、用量、能力声明和类型化 adapter 错误。

验收：

- Schema 可对合法样例往返编解码，并拒绝缺少 ID、越界 token 用量和未知结果变体。
- adapter ID 不允许 `/`；模型引用只在第一个 `/` 处分割，保留完整 model ID。
- 错误至少区分配置、认证、限流、超时、取消、供应商响应和协议解码失败。
- 协议不引用 Gemini 或 Koishi 具体类型。

### YK-003 模型发现协议与 adapter 契约测试包

前置：YK-002。

交付：为 adapter 增加可取消的 `discoverModels` 能力，定义不可变的模型快照、发现时间、模型 ID/显示名、token 上限、生成方法和“支持/不支持/未知”能力状态，同时提供所有 adapter 可复用的契约测试。

验收：

- 契约测试可验证 ID 唯一、结果排序稳定、不可变快照、取消传播和错误分类。
- 协议允许 adapter 只报告供应商明确返回的能力，不得把未知能力当作已支持。
- 发现接口不包含消息、人格、记忆或发送权限。

### YK-004 Gemini adapter 插件骨架与安全配置

前置：YK-002。

交付：创建 `@yokai/koishi-plugin-yokai-adapter-gemini`，引入官方 `@google/genai`，将 API key、base URL、超时和重试策略从 Koishi 配置转换为显式 Effect 服务，并提供可由后续注册表持有的 adapter Layer。

验收：

- 无 key 时给出角色外配置错误，不发出网络请求。
- adapter 配置中不存在 primary、fallback 或任何“当前模型”字段。
- API key 在 Schema、错误、日志和测试快照中均不以明文出现。
- `GoogleGenAI` 客户端只在 Layer 作用域内构造，SDK 类型不出现于 `@yokai/protocol` 公开声明。
- SDK Promise 通过 `Effect.tryPromise` 调用，SDK 异常在服务边界翻译为类型化 adapter 错误。
- adapter Layer 的作用域关闭后，进行中请求被中断且 HTTP 资源被释放。

### YK-005 Gemini 可用模型自动发现

前置：YK-003、YK-004。

交付：通过 `ai.models.list` 调用 Gemini Developer API，发现当前凭据可用的模型，读完 SDK 分页器的所有页，并归一化为通用模型快照。

验收：

- 模拟三页结果时每页只请求一次，后续请求使用上页 token，最终无重复、无遗漏。
- 只暴露 `supportedGenerationMethods` 包含 `generateContent` 的模型；保留供应商返回的 token 上限和方法列表。
- 规范化 `models/<id>` 前缀，用规范 ID 去重并产生稳定顺序。
- 启动、配置更新和手动刷新可触发发现；处理普通群消息时发现请求数为 `0`。
- 刷新失败保留上次成功快照并返回类型化状态；首次发现失败不伪造默认模型。
- 配置的模型不可用时不静默切换，除非主体明确配置了 fallback。

### YK-006 Gemini 文本生成闭环

前置：YK-002、YK-004、YK-005。

交付：将统一 system/对话请求、生成参数和中止信号转换为 `ai.models.generateContent` 或 `generateContentStream` 调用，将候选文本、停止原因和 token 用量转回通用结果。流式输出只用于传输与统计，主体仍在完整 `ResponsePlan` 校验后发送。

验收：

- HTTP 黄金测试覆盖 system instruction、多轮角色映射、参数和模型 ID。
- 流式分块可按顺序合并为与非流式一致的最终结果，不会边生成边向群聊发送。
- 空 candidate、安全拦截、非 2xx 和畸形 JSON 都转换为类型化失败。
- 取消 `AbortSignal` 会中断底层 HTTP 请求，不留下后台 fiber。
- 未经主体调用时，adapter 不读写任何人格、历史、记忆或 Koishi Session。

### YK-007 Gemini 结构化输出与工具调用

前置：YK-006。

交付：支持 JSON Schema 结构化输出、工具声明和工具调用结果，使 `ResponsePlan` 和分页历史工具可使用同一 adapter 协议；续轮上限由后续主体回合编排负责。

验收：

- 结构化结果经过 Schema 解码，缺字段或越界数值不进入主管线。
- 一个模型工具调用能通过模拟宿主回传工具结果并完成续轮，adapter 本身不执行工具。
- 每次 SDK 调用都显式禁用 automatic function calling，并将 `FunctionCall` 作为数据返回主体。
- `models.list` 未报告的模型级能力保持 `unknown`；供应商明确拒绝结构化输出或工具时转换为类型化的不支持错误，不伪造成普通回复。

### YK-008 Gemini 稳定性、用量与脱敏

前置：YK-006。

交付：关闭 `@google/genai` 内建重试，再为发现和生成请求加入 Effect 控制的有界超时、仅针对可重试失败的退避策略、标准用量/耗时数据和安全日志。

验收：

- 429 和指定 5xx 按上限重试；401/403、协议解码失败和取消不重试。
- 断言 SDK 单次调用的底层 HTTP 请求数为 `1`，不会与 Effect 重试叠加。
- 用 `TestClock` 验证退避次数和总超时，无真实 sleep。
- 日志只含 adapter/model ID、状态、用量和耗时，不含 key、完整提示或完整回复。
- Gemini adapter 通过 YK-003 的全部契约测试。

## 3. 主体最小纵切

### YK-009 能力注册表与回合快照

前置：YK-002。

交付：实现 adapter、tool、skill、MCP、preset source 和 response mechanism 的注册/注销，以及不可变的回合能力快照。adapter 模型快照合并到主体持有的 `SubscriptionRef`。

验收：同 ID 冲突被拒绝；卸载后新回合不可见；旧回合快照不受安装、卸载影响；模型目录快照版本单调增加且原子替换；一个扩展注册失败不影响其他扩展。

### YK-010 `ctx.yokai` Koishi 服务边界

前置：YK-009。

交付：由主体插件暴露 `ctx.yokai`，将 Koishi 生命周期、配置和 Session 转成内部 Effect 服务输入。在主插件 Config 中定义使用 `Schema.dynamic('yokai-model')` 的可选 primary 和有序 fallback。

验收：第三方测试插件可注册并注销能力；primary/fallback 只出现在主插件 Config；无 primary 时主插件仍可启动本地存档路径；内部包无 Koishi 依赖；插件 dispose 会中断主体所有有主的 fiber。

### YK-011 实时模型目录与主插件选择

前置：YK-005、YK-009、YK-010。

交付：主体聚合所有 adapter 的最新模型快照，订阅目录 `SubscriptionRef`，并在每次更新时通过 `ctx.schema.set('yokai-model', Schema.union(...))` 实时更新主插件的 primary/fallback 选项。当前配置中已选但不可用的引用使用 `Schema.const(ref).disabled()` 保留。按模型引用验证选择，并向控制面提供刷新和状态查询。

验收：

- 假 adapter 注册、发布新快照、卸载和重新注册时，主插件配置选项均立即更新，不重载主插件。
- 每次有效目录变化只发出一次 `internal/schema('yokai-model')`，内容未变时不重复发布。
- 选项值是稳定模型引用，显示文案可变但不会改写配置。
- 已选但不可用的模型以禁用选项保留，主体返回类型化 unavailable 状态并不创建模型回合。
- 已选模型再次可用时，下一回合自动恢复，不需要保存配置或重启。
- 发现失败保留上次成功选项并标记 stale；从未成功时只显示当前已选的禁用项。
- 同一 adapter 两次发现乱序完成时，旧作用域或旧请求的结果不会覆盖新快照。
- fallback 去重、不得重复 primary，且只按主插件显式配置顺序启用。

### YK-012 直接 @ 的最小端到端回路

前置：YK-006、YK-010、YK-011。

交付：先不引入活跃度、记忆和工具，完成“Koishi 收到 @ → 冻结少量消息 → Gemini 文本生成 → 发送一条消息”的最小纵切。

验收：使用假 Gemini HTTP 服务的 Koishi 集成测试只发出一次模型请求和一条群消息；非 @ 消息不调用模型；adapter 错误时群聊保持沉默。

## 4. 存档、门控与回合管线

### YK-013 规范化事件与消息存档

前置：YK-001、YK-010。

交付：定义 `NormalizedEvent`，实现 `yokai_message` 作用域隔离、编辑、撤回、删除和稳定索引。

验收：同 message ID 重放幂等；编辑/撤回可见；不同实例、平台、群和频道之间无读取泄漏；自身消息可标记但不进入活跃度。

### YK-014 稳定游标分页历史

前置：YK-013。

交付：实现基于 `(timestamp, messageId)` 的 before/after 游标，以及作者、关键词、页数和 token 预算限制。

验收：同时间戳不丢消息；分页期间插入新消息不造成重复/漂移；默认 40、上限 100；篡改游标、跨作用域和超预算请求均失败。

### YK-015 频道环形缓冲与冻结快照

前置：YK-013。

交付：每频道维护最近消息缓冲，按 20～80 条和 token 预算创建单一不可变回合快照。

验收：达到条数或 token 上限时优先保留 focus 和最近消息；生成期间到达的新消息只进入下一个快照。

### YK-016 活跃度、相关度与动态阈值纯逻辑

前置：YK-013。

交付：实现半衰期、消息脉冲、本地相关度、冷却压力和预算压力的无 I/O 计算。

验收：文档初始参数的表格化测试通过；重复/其他机器人/自身消息不加分；阈值随压力单调不降；整个计算不发生网络 I/O。

### YK-017 分类调用预算

前置：YK-001。

交付：实现 minute/day 窗口与 reserved/normal/background 预算的原子预留、提交和释放。

验收：并发争用不超额；失败回合按规则释放或记账；日窗口按配置时区翻转；normal 用尽不会偷用 reserved。

### YK-018 WakeArbiter 与 direct/activity 机制

前置：YK-009、YK-015、YK-016、YK-017。

交付：实现 `WakeProposal` 合并、过期、优先级、频道锁、debounce、冷却和预算，接入内置 direct/activity 机制。

验收：同 `scopeId + mergeKey` 爆发只创建一回合；@/回复可绕过活跃度但仍合并补充消息；社会触发必须同时过阈值、冷却和预算；冷路径模型请求数为 `0`。

### YK-019 版本化人格预设热更新

前置：YK-009。

交付：实现 Persona Schema、文件 preset source、debounce、编译/hash 和原子快照替换。

验收：合法修改只影响下一回合；畸形文件保留最后有效版；相同 hash 不重复发布；更新不清理关系、记忆、租约或定时任务。

### YK-020 结构化 ResponsePlan 与角色内提示

前置：YK-002、YK-019。

交付：定义 `silence/react/reply/follow-up/initiate` 的结构化结果、事实来源、消息长度和记忆写入提案，编译严格角色内提示。

验收：所有变体穷尽解码；reply 必须有合法 message，silence 不得携带待发文本；fact 必须有来源；提示包含设计文档中的角色外禁语和工具不信任边界。

### YK-021 回合编排、发送与失败沉默

前置：YK-007、YK-011、YK-014、YK-018、YK-020。

交付：组装单一冻结上下文，执行有界模型/历史工具续轮，校验 `ResponsePlan`，并按长度和场景计算发送节奏。

验收：默认只有一次模型请求；历史续轮不超配置页数/token/请求上限；决策为 silence 时不发送；适配器、工具、解码、超时和限流错误都不进入群聊；生成后不重读频道。

## 5. 仿生能力增量

### YK-022 话题线程与场景理解

前置：YK-013、YK-020。

交付：维护有界 `ThreadState`，从当前快照产生话题、参与者、模式、指向性和“已有充分回应”特征。

验收：固定多话题回放样例中，回复归属正确线程；过期线程归纳或删除；场景计算不发起独立远程模型请求。

### YK-023 代理状态与成员关系

前置：YK-013、YK-022。

交付：持久化心境、社交精力、近期参与、未完事项和多维成员关系，并用有界纯函数更新。

验收：单次互动变化不超配置上限；熟悉度不等于单一好感度；离线后中期状态保留、短期状态按时间衰减；更新幂等且作用域隔离。

### YK-024 四类记忆的写入、检索、冲突与遗忘

前置：YK-013、YK-020、YK-023。

交付：实现 episode/fact/relationship/self 记忆，来源追溯，作用域过滤，话题/对象/时间/重要度排序，以及纠正和过期。

验收：无来源提案不入库；新纠正会降低或替代冲突旧记忆；低置信记忆不召回，中置信记忆带不确定标记；跨实例/群聊检索为空。

### YK-025 持续讨论租约

前置：YK-018、YK-021。

交付：在 @/回复后建立有界 `EngagementLease`，支持延长/关闭 directive 和 continuation 提案。

验收：只有租约参与者可继续触发；多段消息仍合并；TTL、最大轮数、转话题和显式关闭均可结束租约；过期后恢复普通门控。

### YK-026 持久化定时任务

前置：YK-009、YK-017、YK-018、YK-021。

交付：实现 `schedule.query/create/update/cancel` Tool、最近任务调度器和 scheduled 响应机制。

验收：时区和宿主当前时间参与解析；`dedupeKey` 防止续轮重复创建；重启恢复且每项最多触发一次；错过任务按 grace period 处理；仅消耗 reserved 预算。

### YK-027 Tool/Skill/MCP 可见性与热插拔

前置：YK-009、YK-021。

交付：实现本地 Skill 选择、Tool 允许列表/风险/超时校验、MCP 命名空间投影与断线重连。

验收：冷路径不用远程模型选 Skill；回合只暴露 allowlist 内且不超数量上限的 Tool；MCP tool 使用 `<server>.<tool>` ID；断线只移除该服务新快照中的能力，不影响其他能力。

### YK-028 受限主动发言

前置：YK-017、YK-021、YK-023、YK-024。

交付：仅从未完话题、高相关近期内容和允许的固定群活动生成 initiative 提案。

验收：默认不主动私聊；无具体社会动机不提案；频道冷却、关系阈值和 background 预算任一不满足时不创建回合。

## 6. 控制面与评测

### YK-029 数据库迁移与管理命令

前置：YK-013、YK-017、YK-019、YK-023、YK-024、YK-026。

交付：汇总并验证前置任务逐项引入的最小表集与版本迁移，增加有权限的查询/停用/删除命令，并确保管理输出不经过角色管线。

验收：空库可升级，重复迁移幂等；按作用域删除不影响其他范围；普通群成员无法调用管理命令；技术错误只出现在控制面。

### YK-030 Console 控制面

前置：YK-011、YK-019、YK-029。

交付：提供 Koishi Console 页面与后端服务，管理预设、频道停用和数据操作，并展示 adapter 状态、最近发现时间、发现的模型及手动刷新操作。模型选择继续使用主插件原生配置表单，此页不维护第二份选择状态。

验收：

- 状态页与主插件配置表单读取同一模型目录快照，不存在前端固定列表或独立选中值。
- 用户可查看上次成功/失败状态并手动刷新；刷新不阻塞普通消息存档。
- 已配置但当前不可用的模型显示明确警告，不自动改写配置。
- 页面、RPC 和浏览器日志均不返回 API key、完整群聊或完整模型提示。

### YK-031 调试指标与成本回放

前置：YK-018、YK-021、YK-029。

交付：记录活跃度分布、触发原因、合并数、模型请求/历史页数、token、费用、行为和耗时，提供离线回放。

验收：同一录制输入在固定 Clock/随机服务下得到同一门控结果；可汇总每 100 条消息回合数和每千条成本；调试输出脱敏且不发送到群聊。

### YK-032 助手腔检测与盲测数据集

前置：YK-021、YK-031。

交付：建立角色外术语/模板化表达检测、匿名化群聊切片导出和人类/Yokai 盲测记录格式。

验收：设计文档列出的角色外表达全部被检测；导出不包含账号标识、adapter/model 信息或密钥；同一输出可比较来源识别率、消息长度/节奏差异和角色外泄漏率。

## 7. 推荐交付批次

| 批次 | 任务           | 可演示结果                                                    |
| ---- | -------------- | ------------------------------------------------------------- |
| A    | YK-001～YK-005 | Gemini adapter 能使用凭据自动列出全部可用文本生成模型         |
| B    | YK-006～YK-008 | Gemini adapter 独立通过发现、生成、结构化输出、工具和容错契约 |
| C    | YK-009～YK-012 | 主插件配置实时展示 adapter 模型，@ Yokai 后使用选中模型回复   |
| D    | YK-013～YK-021 | 存档、门控、历史工具、人格和结构化回合管线完整运行            |
| E    | YK-022～YK-028 | 话题、状态、关系、记忆、讨论租约、定时与主动行为逐项可用      |
| F    | YK-029～YK-032 | 可运维、可计费、可回放并可执行盲测的 MVP                      |

Gemini `models.list` 的分页、`supportedGenerationMethods` 和 token 上限字段以
[Gemini Developer API 官方模型参考](https://ai.google.dev/api/models)为验收基准，不在代码中维护固定模型名单。
