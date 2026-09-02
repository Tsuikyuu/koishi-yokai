# Yokai 可验收实施任务

依据：[`yokai-design.md`](./yokai-design.md)

首发 adapter：`koishi-plugin-yokai-adapter-gemini`

可选增强插件：`koishi-plugin-yokai-console`；主体不得依赖或要求安装该包。

主体不在聊天平台注册管理命令；角色外管理只通过主插件原生 Config 和安装时才存在的可选 Console 完成。

Gemini 客户端：Google 官方 `@google/genai` v2 API，以实例级 fetch 注入接入 Koishi HTTP

## 1. 拆分原则

- 每个任务只交付一个协议、纯逻辑、持久化能力、adapter 能力或端到端行为。
- 任务只依赖“前置”栏中列出的任务；前置完成后，该任务可单独开发、评审和验收。
- 除端到端任务外，验收不依赖真实 Gemini 账号或真实群聊，使用可控的 Layer、HTTP 模拟和 Koishi 测试实例。
- 所有任务都必须通过 `yarn build` 和 `yarn lint`；时间相关测试使用 `TestClock`，不等待真实时间。
- 应用逻辑使用 Effect，`Effect.run*` 只能出现在 Koishi 边界和测试基础设施。
- `@google/genai` 只存在于 Gemini adapter 工作区，锁定稳定 2.x 精确版本；所有 SDK Promise、完整响应和错误都在 adapter 边界转换为 Effect 和 `yokai-protocol` 类型。
- 单一模型选择只存在主插件配置；adapter 仅发布模型快照，不保存当前模型。
- 模型自动发现不承担能力探测；MVP 的 `feedbackToolsEnabled` 由使用者在主插件显式配置。
- Yokai 是角色扮演仿生人群友，不实现通用 Agent 规划—工具—观察循环；single-pass 回合一次逻辑生成，
  bounded-feedback 回合最多两次逻辑生成。
- ActionTool 以版本化 XML 模板暴露且不回灌结果；FeedbackTool 使用通用函数调用，结果只回传一轮。
- 在当前协议主版本内，新增 LLM adapter 只能新增该 adapter 插件包，不得修改 protocol、主体、内部包或其他 adapter。

## 2. 优先交付：Gemini adapter

### YK-001 工作区与测试基线

前置：无。

交付：创建 `protocol`、`core`、`mind`、`memory` 和 `yokai-adapter-gemini` 工作区骨架，配置统一的单元测试入口。

验收：

- 每个工作区可独立类型检查，根工作区能构建全部包。
- 每个导入 Effect 的工作区都精确声明 `effect@4.0.0-rc.110`。
- Gemini adapter 将 `@google/genai` 锁定为稳定 2.x 精确版本，并声明 `node >= 20` 运行时基线；
  其他工作区不引入该 SDK。
- 包名、依赖方向和输出目录符合设计文档，没有 Koishi 依赖泄漏到内部包。

### YK-002 通用 adapter 协议

前置：YK-001。

交付：在 `yokai-protocol` 定义完整 `YokaiAdapter` 接口、稳定 ID、协议版本与注册前握手、`<adapterId>/<modelId>` 模型引用、可表达逐模型 fresh/stale 的不可变 adapter 模型发现快照、`discoverModels/generate/continue`、统一文本/FeedbackTool 生成请求、文本或 ToolCallBatch 结果、ToolResultBatch、用量、adapter 级 FeedbackTool 契约声明和类型化 adapter 错误。代码级规范见 [`yokai-llm-adapter-protocol.md`](./yokai-llm-adapter-protocol.md)。

验收：

- 可持久化 Schema 可对合法样例往返编解码，并拒绝缺少 ID、越界 token 用量和未知结果变体；continuation 支持内存 Schema 往返，但 canonical JSON 编码必须失败。
- Tool call/result 通过稳定 call ID 关联；协议支持同一批多个调用，但不包含厂商 FunctionCall 类型。
- ToolCallBatch 携带不透明 continuation handle；YK-002 固定单次消费和不暴露供应商历史的语义，实际状态机行为由 YK-003 conformance suite 验证。
- `continue` 只接受原 adapter 的 handle 和通用 ToolResultBatch，且只能返回最终文本；协议没有开放式续轮方法。
- `generate` 的 Effect 环境提供角色回合 Scope，使实现能把 handle 绑定 adapter、model 和 owning Scope；YK-002 固定 Scope 关闭即失效且 `continue` 不比较当前子 Scope identity 的契约，运行时验证归 YK-003。
- adapter ID 不允许 `/`；模型引用只在第一个 `/` 处分割，保留完整 model ID。
- 协议版本显式区分 major/minor；兼容 minor 可注册，不兼容 major 由统一握手在调用发现或生成前拒绝，adapter 方法调用数为 `0`。
- 错误至少区分配置、认证、限流、超时、取消、供应商响应和协议解码失败。
- adapter 只声明是否实现 FeedbackTool 传输契约；协议没有逐模型能力探测方法或能力探测请求。
- 协议不引用 Gemini 或 Koishi 具体类型。
- 通用请求不含 `providerOptions`、任意厂商扩展字典或厂商枚举；adapter 专属配置不进入主插件。

### YK-003 adapter 发现与完整契约测试包

前置：YK-002。

交付：基于 YK-002 已定义的不可变 adapter 模型发现快照和 adapter 级 FeedbackTool 契约声明，提供所有 adapter 可复用的供应商无关契约测试与确定性 fake adapter；主体全局模型目录的 revision 和状态仍由后续注册表任务定义。代码级设计、测试 factory 与包入口见 [`yokai-adapter-conformance.md`](./yokai-adapter-conformance.md)。

验收：

- 契约测试验证 ID 唯一、结果排序稳定、不可变快照、逐模型 freshness、取消传播和错误分类；快照内容等价比较排除 `discoveredAt`。
- 契约测试分别覆盖 single-pass 文本结果，以及 ToolCallBatch → 单次 continue → 最终文本结果。
- continuation 必须绑定原 adapter/model/回合、单次消费并随作用域失效；重复或跨 adapter 消费失败。
- `generate` 或 `continue` 每次调用只表示一次同模型逻辑生成；adapter 可按私有策略执行有界的等价端点尝试，
  但不得改变模型或形成新的编排步骤；再次 ToolCall 作为协议失败。
- 模型快照不包含主动探测或推断出的逐模型能力；供应商未返回的元数据保持缺失。
- fake adapter 分别覆盖实现和未实现 FeedbackTool 传输契约的注册形态。
- 发现接口不包含消息、人格、记忆或发送权限。
- fake adapter 不包含 Gemini 或其他真实厂商语义，供主体集成测试验证其只依赖通用协议。

### YK-004 Gemini adapter 实例、单逻辑连接与端点配置

前置：YK-002。

交付：创建 `koishi-plugin-yokai-adapter-gemini`，每个 Koishi 插件实例拥有一个 adapter 和一条
逻辑连接；引入官方 `@google/genai` v2，将顶层 `adapterId`（默认 `gemini`）、一份非空、有序的
`endpoints`（每项仅含 `baseUrl` 和 `apiKey`），以及顶层共享的 `requestTimeoutMs`、`maxConcurrency`
和仅用于后台发现的 `discoveryRetry`，从 Koishi 配置转换为该实例单一逻辑连接的显式 Effect 服务。Koishi `apply` 边界把
当前插件上下文的 `ctx.http` 转换为 adapter-private HTTP transport Layer，并在构造每个 `GoogleGenAI`
实例时注入该实例专属的 fetch implementation；最终提供可由后续注册表持有的 adapter Layer。

验收：

- `adapterId` 省略时为 `gemini`；若有多个插件实例同时注册到同一 Yokai 主体，它们必须配置不同的合法
  `adapterId`。YK-009 注册表仍明确拒绝同一 adapter ID 的后注册者；Gemini 插件不声明 Koishi `reusable` 策略。
- `adapterId` 非法、`endpoints` 为空、任一 endpoint 缺少 key、任一显式 base URL 非法，或顶层共享配置非法时给出角色外配置错误，
  不发出网络请求；省略 base URL 时使用 Gemini 官方服务根 URL。
- endpoint 项严格只有 `baseUrl` 和 `apiKey`，不接受额外身份、显示文案、独立超时或独立重试字段；
  所有 endpoint 使用相同的 `requestTimeoutMs`、`maxConcurrency` 和 `discoveryRetry`。
- adapter 配置中不存在 `model` 或任何“当前模型”字段。
- 所有 endpoint 客户端归同一个 adapter Layer 作用域管理；逻辑连接的活动端点初始为配置第一项，只有
  完整成功的逻辑调用才更新活动端点，并发成功调用以最后完成者为准。
- API key 在 Schema、错误、日志和测试快照中均不以明文出现。
- `GoogleGenAI` 客户端只在 Layer 作用域内构造；ClientFactory 只依赖窄 HTTP transport 服务，不持有完整
  Koishi `Context`，SDK 和 Koishi 类型均不出现于 `yokai-protocol` 公开声明。
- 每个 SDK client 只使用自己的注入 fetch；不得替换 `globalThis.fetch`、设置进程级 dispatcher、自建第二套
  代理配置或直接创建绕过 `ctx.http` 的网络客户端。两个 Koishi Context 并发时 HTTP 配置不得串线。
- 注入 fetch 必须通过 `ctx.http` 解析 `http/config`、context intercept、默认 headers、keep-alive 和
  `http/fetch-init`/proxy-agent。SDK 给出的绝对 endpoint、认证、Content-Type 和其他单次请求字段冲突时优先。
- fetch bridge 把 SDK Headers 规范化为普通 entries，转发 method、body、signal、redirect 和 keepalive，对所有
  HTTP status 保留原始 status/statusText/headers，并在 `ctx.http` decoder 内完整读完 unary body 后重建标准
  `Response`；非 `2xx` 仍由 SDK 转换为 `ApiError`，不能在 body 消费前让 `ctx.http` 提前撤销 timeout 或 dispose 管理。
- SDK 的内建 timeout 和 retry 均保持关闭。`requestTimeoutMs` 由 Effect 对每个 endpoint 尝试施加硬截止并
  通过 AbortSignal 传播到 SDK、注入 fetch 和 `ctx.http`；Koishi HTTP 自身的全局 timeout 仍生效，较早者终止请求。
- Gemini adapter 的发布依赖是直接提供实例级 fetch 注入口的 Google 官方 `@google/genai` 稳定 2.x
  精确版本；发布包不依赖仓库级 patch。
- SDK Promise 通过 `Effect.tryPromise` 调用，SDK 异常在服务边界翻译为类型化 adapter 错误。
- adapter Layer 的作用域关闭后，进行中的 header 或 body 读取均被中断，client 引用和密钥被释放；共享的
  `ctx.http` 服务仍归 Koishi Context 所有，adapter 不主动 dispose 它。

### YK-005 Gemini 可用模型自动发现

前置：YK-003、YK-004。

交付：插件实例的 adapter 从自身逻辑连接的当前活动端点开始，通过 `ai.models.list` 调用 Gemini Developer API，
读完 SDK 分页器的所有页，并发布首个完整成功端点的一份通用模型快照；不同 endpoint 的发现结果不合并。

验收：

- 单 endpoint 模拟三页结果时每页只请求一次，后续请求使用上页 token，最终无重复、无遗漏。
- 明确返回方法列表时只暴露其中包含 `generateContent` 的模型；方法列表缺失时保留模型但不臆造能力；
  保留供应商返回的 token 上限和方法列表。
- 规范化 `models/<id>` 前缀；adapter-local ID 只使用 `providerModelId`，按规范 ID 去重并产生稳定顺序，
  不含任何传输源前缀。
- 同一模型可经多个 endpoint 访问时仍只形成一个候选；完整模型引用为 `<adapterId>/<providerModelId>`，
  endpoint 不贡献模型身份或显示文案。
- 分页中途遇到可切换错误时丢弃当前 endpoint 的所有已读页面，在下一 endpoint 从第一页重新开始；
  任一页失败均不更新活动 endpoint，只有读完全部页面才更新并发布该 endpoint 的完整快照，绝不拼接
  部分页面或多个 endpoint 的模型。
- 畸形分页、重复 page token、超过 100 页或累计超过 10,000 个模型时返回不可切换的协议解码错误，
  不允许单个兼容 endpoint 通过循环 token 或持续成功的小分页绕过逻辑调用上界。
- 启动、配置更新和手动刷新可触发发现；处理普通群消息时发现请求数为 `0`。
- 一次发现的全部 endpoint 耗尽时保留逻辑连接上次成功的整份快照并标记 stale；首次发现失败不伪造默认模型。
- 发现流程不发起函数调用或其他模型能力探测请求。
- 配置的模型未出现在成功快照时不由 adapter 合成，主体也不得改选其他模型。
- endpoint 故障转移始终保持相同 `providerModelId`；它不改变主插件的模型选择。一次逻辑生成开始后，主体不得因
  endpoint 耗尽或其他失败在同一角色回合切换模型。

### YK-006 Gemini 文本生成闭环

前置：YK-002、YK-004、YK-005。

交付：将统一 system/对话请求、生成参数和中止信号转换为一次同模型逻辑生成；每个 endpoint 只调用
`ai.models.generateContent`，等待完整响应后将首个成功端点的候选文本、停止原因和 token 用量转回通用结果。
Yokai 不调用 `generateContentStream`，不发送 `alt=sse`，也不请求、解析或消费任何 SSE。

验收：

- HTTP 黄金测试覆盖 system instruction、多轮角色映射、参数和模型 ID。
- HTTP stub 断言每次物理尝试只调用 unary `generateContent`，`generateContentStream` 调用数为 `0`，请求 URL
  不含 `alt=sse`，响应必须完整读完并解码后才能形成 adapter 结果。
- 空 candidate、安全拦截、非 2xx 和畸形 JSON 都转换为类型化失败。
- 取消 `AbortSignal` 会中断底层 HTTP 请求，不留下后台 fiber。
- 未经主体调用时，adapter 不读写任何人格、历史、记忆或 Koishi Session。
- 一次 `generate` 服务调用按 adapter-local `providerModelId` 在活动 endpoint 起始的有序列表上保持同一模型，
  只形成一次逻辑生成；物理 HTTP 尝试数由有界 endpoint 故障转移决定。

### YK-007 Gemini FeedbackTool 函数调用边界

前置：YK-006。

交付：把通用 FeedbackTool 定义编译为 Gemini function declarations，将厂商 FunctionCall 解码为通用 ToolCallBatch，并把主体返回的一批 ToolResult 编码为同一模型的唯一最终生成请求。adapter 不执行 Tool，也不解析最终 XML。

验收：

- 未选择 FeedbackTool 时省略 `tools`/`toolConfig`，一次调用直接返回包含 XML 的完整文本。
- 选择 FeedbackTool 时设置 function declarations、`FunctionCallingConfigMode.AUTO` 和 `automaticFunctionCalling.disable = true`；SDK 不自动执行或续轮。
- 同一候选中的多个 FunctionCall 保留顺序并解码输入；供应商缺少 ID 时生成 continuation 内稳定的 call ID，同时出现的临时文本标记为不可发送。
- ToolResult 与规范化 call ID 一一对应并编码为原调用的 function response；最终调用使用同一模型、完整调用历史和 `FunctionCallingConfigMode.NONE`。
- 带 `thoughtSignature` 的模拟响应中全部 Part 通过 continuation handle 原样回传，不由主体重建。
- continuation handle 成功消费、超时、取消或 adapter scope 关闭后立即失效，重复消费产生类型化错误。
- 最终完整响应中的 XML 和转义字符可无损保留；最终仍返回 FunctionCall 时产生类型化协议失败。
- adapter 公开协议中不出现 Gemini FunctionCall/FunctionResponse 类型。
- 完成本任务后 Gemini adapter 声明已实现通用 FeedbackTool 传输契约；该声明与逐模型能力无关。

### YK-008 Gemini 稳定性、用量与脱敏

前置：YK-006、YK-007。

交付：保持 `@google/genai` 内建 retry 和 timeout 关闭，以 Effect 实现单次逻辑调用内的有序 endpoint
故障转移，为每个 endpoint 尝试应用顶层共享硬超时，以 `maxConcurrency` 限制实例级并发逻辑调用，
并为后台模型发现加入顶层共享的有界退避；
`ctx.http` 的全局网络配置独立生效。分别记录逻辑生成数、物理 endpoint 尝试数、用量、耗时和安全日志。

验收：

- 每次 `discoverModels/generate/continue` 从当前活动 endpoint 开始，之后按配置顺序循环，每个 endpoint
  在该逻辑调用内至多尝试一次；只有完整成功的逻辑调用才将其成功 endpoint 原子地设为后续调用起点，
  并发成功调用以最后完成者为准。模型发现只有完整读完所有分页才算成功，任一页失败均不更新活动 endpoint；
  全部耗尽时返回最后错误。
- `maxConcurrency` 默认为 `4`、合法范围 `1..64`，在单个 adapter 实例内由发现、生成和 continuation 共享；
  permit 覆盖排队后的完整逻辑调用（所有 endpoint 尝试、完整响应读取和协议解码），排队可被调用方取消且不会触达 SDK。
  后台发现每次重试是新的逻辑调用，退避等待期间不占用 permit。
- `401/403`、`402/429`、`408/504`、顶层 `requestTimeoutMs` 超时、传输错误和其他 `5xx` 切换下一
  endpoint；调用方取消、其余普通 `4xx`、协议解码、能力不支持以及内容/安全错误不切换。
- Koishi `ETIMEDOUT`、其他代理/请求/body 读取失败、SDK 非 `2xx` 以及成功 status 下的畸形 payload 分别稳定映射为
  timeout、transport、对应 provider error 和 protocol decode；调用方取消与 Layer dispose 保持 Effect interruption。
- 一次发现先完成上述有界 endpoint 尝试；只有后台发现对最终 `429` 和 `500/502/503` 按 `discoveryRetry`
  退避后发起新的逻辑发现调用。认证错误、协议错误和取消不进入后台重试，生成也不安装自动重试。
- 生成只使用完整的 unary 响应；超时或可切换传输失败后尝试下一 endpoint 时，原请求可能已经被接受或完成，
  文档、日志指标和测试必须明确重复生成与重复计费这一不可消除的风险。
- 断言每次 adapter `generate/continue` 只有一次同模型逻辑生成，底层 HTTP 尝试数不超过 endpoint 数；
  single-pass 回合逻辑生成总数为 `1`，bounded-feedback 为 `2`，永不产生第三次逻辑生成。
- endpoint 耗尽后不切换主插件选中的模型，并保持群聊沉默。
- 用 `TestClock` 验证发现退避和生成硬超时，无真实 sleep。
- 日志只含 adapter/model ID、状态、用量和耗时，不含 key、continuation handle、完整提示或完整回复。
- Gemini adapter 通过 YK-003 的全部契约测试。

## 3. 主体最小纵切

### YK-009 能力注册表与回合快照

前置：YK-002。

交付：实现 adapter、ContextProvider、ActionTool、FeedbackTool、skill、MCP、preset source 和 response mechanism 的注册/注销，以及不可变的回合能力快照。adapter 模型快照合并到主体持有的 `SubscriptionRef`。

验收：同 ID 冲突被拒绝；ContextProvider、ActionTool 与 FeedbackTool ID 分域且各自唯一；卸载后新回合不可见；旧回合快照不受安装、卸载影响；模型目录快照版本单调增加且原子替换；一个扩展注册失败不影响其他扩展；注册与分派代码中不存在厂商名称、adapter ID switch 或静态 adapter allowlist。

### YK-010 `ctx.yokai` Koishi 服务边界

前置：YK-009。

交付：由主体插件暴露 `ctx.yokai`，将 Koishi 生命周期、配置和 Session 转成内部 Effect 服务输入。在主插件 Config 中定义使用 `Schema.dynamic('yokai-model')` 的单个可选 `model`，以及默认关闭的 `feedbackToolsEnabled`。

验收：第三方测试插件可注册并注销能力；`model` 和 `feedbackToolsEnabled` 只出现在主插件 Config；未选模型时主插件仍可启动本地存档路径；内部包无 Koishi 依赖；插件 dispose 会中断主体所有有主的 fiber。

### YK-011 实时模型目录与主插件选择

前置：YK-003、YK-009、YK-010。

交付：主体聚合所有 adapter 的最新模型快照，订阅目录 `SubscriptionRef`，并在每次更新时通过 `ctx.schema.set('yokai-model', Schema.union(...))` 实时更新主插件的单个 `model` 选项。当前配置中已选但不可用的引用使用 `Schema.const(ref).disabled()` 保留。按模型引用验证选择，并向控制面提供刷新和状态查询。

验收：

- 假 adapter 注册、发布新快照、卸载和重新注册时，主插件配置选项均立即更新，不重载主插件。
- 每次有效目录变化只发出一次 `internal/schema('yokai-model')`，内容未变时不重复发布。
- 选项值是稳定模型引用；显示文案固定为全小写的 `<adapterId>/<model>`，连续空白替换为 `-`，但不改写原始配置值。
- 已选但不可用的模型以禁用选项保留，主体返回类型化 unavailable 状态并不创建角色回合。
- 已选模型再次可用时，下一回合自动恢复，不需要保存配置或重启。
- 发现失败保留上次成功选项并标记 stale；从未成功时只显示当前已选的禁用项。
- 同一 adapter 两次发现乱序完成时，旧作用域或旧请求的结果不会覆盖新快照。
- 每次请求前只解析主插件显式选择的单个模型，不按目录顺序自动改选其他模型。
- 模型目录更新不会触发逐模型能力探测；切换 `feedbackToolsEnabled` 也不会产生供应商请求。

### YK-012 直接 @ 的最小端到端回路

前置：YK-003、YK-010、YK-011。

交付：在不引入活跃度、记忆和工具的边界内，定义只支持单条消息或沉默的最小 XML response schema，
使用 YK-003 的 fake adapter 完成“Koishi 收到 @ → 冻结少量消息 → 通用 adapter 生成 XML → 严格解析
→ 发送一条角色消息”的供应商无关最小纵切。

验收：Koishi 集成测试只通过 `YokaiAdapter` 调用 fake adapter，发出一次生成请求和一条群消息；主体测试不导入 Gemini SDK 或 Gemini adapter；非 @ 消息不调用模型；XML 或 adapter 错误时群聊保持沉默且不泄漏协议文本。

## 4. 存档、门控与回合管线

### YK-013 规范化事件与消息存档

前置：YK-001、YK-010。

交付：定义 `NormalizedEvent`，实现 `yokai_message` 作用域隔离、编辑版本、稳定索引、可配置保留期和后台超期清理；原始消息默认保留 90 天。

验收：同 message ID 重放幂等，编辑后查询可见最新版本且保留来源关系；不同实例、平台、群和频道之间无读取泄漏；自身消息可标记但不进入活跃度；默认 90 天和自定义保留期均由 `TestClock` 验证边界；MVP 不监听撤回或删除事件，也不提供消息级或手动删除流程。

### YK-014 稳定游标历史、ContextProvider 与 FeedbackTool

前置：YK-009、YK-013。

交付：实现基于 `(timestamp, messageId)` 的 before/after 游标、由主体在首次生成前选择相关历史的 ContextProvider，以及模型按作者、关键词和时间范围查询的只读 `history.search` FeedbackTool。

验收：同时间戳不丢消息；分页期间插入新消息不造成重复/漂移；默认 40、上限 100；篡改游标、跨作用域和超预算请求均失败；FeedbackTool 结果可进入唯一最终生成，但最终请求不再暴露历史 Tool，不能连续翻页。

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

验收：同 `scopeId + mergeKey` 爆发只创建一回合；插件可分别开关真实 @、回复自身消息、当前 preset 完整角色名前缀和角色名任意包含四种硬回复；硬触发使用独立短 debounce，绕过活跃度并合并补充消息；社会触发使用较长消息簇窗口且必须同时过阈值、冷却和预算；冷路径模型请求数为 `0`。

### YK-019 版本化人格预设热更新

前置：YK-009。

交付：实现 Persona Schema、文件 preset source、debounce、编译/hash 和原子快照替换。

验收：合法修改只影响下一回合；畸形文件保留最后有效版；相同 hash 不重复发布；更新不清理关系、记忆、租约或定时任务。

### YK-020 角色 XML 协议、ActionTool 模板与提示

前置：YK-009、YK-012、YK-019。

交付：定义无属性 `<output>` 根；根下依次允许零至四个纯文本 `message` 和可选 `actions`。message
可选唯一的 `quote="VISIBLE MESSAGE ID"` 属性；普通发言默认不带 quote，只有确实需要平台引用的单段
才携带 quote。编译严格角色内提示及当前可见 ActionTool 的精确 XML 模板，并实现安全解析和 Schema
解码。代码级协议见 [`yokai-role-response-protocol.md`](./yokai-role-response-protocol.md)。

编译结果携带宿主持有的 `protocolId = yokai.role-output/2`，该值不进入模型 XML。运行时冻结 ActionTool 注册、
scope 和可见消息 ID 白名单用于校验；普通 turn/审计只保存 protocolId、content-free outcome 与计数，完整快照和
白名单仅按 YK-031 进入受限加密 ReplayEnvelope。

验收：

- 根元素恰为无属性 `<output>`；根级子元素严格按零至四个 message、可选 actions 排列，其他根级元素
  一律拒绝。
- 零个 message 即 silence；一至四个 message 均为非空、已 trim 的纯文本，并完整保留文档顺序。
- message 默认不带属性；quote 仅为对应单段的平台引用元数据，目标必须命中 compiler 冻结的可见 message ID 白名单，普通 message 不隐式补 quote。
- 禁用 DTD、外部实体和网络访问，并限制 XML 字节数、深度、文本长度及动作数量。
- 未知/重复元素、未知 ActionTool、额外参数、越权作用域、畸形转义和 Schema 失败均不能进入执行器。
- 整体 XML 畸形时不猜测或降级提取消息，不向群聊发送 XML 片段。
- ActionTool ID、执行阶段、完成/失败策略来自能力快照，模型只能填写模板参数。
- 提示包含角色外禁语、不可信上下文边界，以及“异步动作完成前不得声称成功”；当前、focus、群聊和用户消息均视为不可信数据，focus 以包含 `messageId`、`authorId`、`timestamp`、`content` 的带标签 JSON block 注入，其 ID 必须进入本回合冻结的 quote 白名单。
- 不增加角色外内容检测、二次 LLM 审查或重写步骤。

### YK-021 有界回合编排、动作执行与失败沉默

前置：YK-003、YK-011、YK-014、YK-018、YK-020。

交付：运行有界 ContextProvider 并组装单一冻结上下文，选择一个可用模型，执行首次生成；文本结果进入 XML 快速路径，ToolCallBatch 则执行一批 FeedbackTool 并进行唯一最终生成；最后校验角色 XML，按注册策略执行 `before-send/after-send/deferred` ActionTool，对一至四个 message 按 XML 顺序逐段发送，并按长度和场景计算首段前等待与段间节奏。生成期间不因新消息或话题变化取消、重做或复核当前回合。

验收：

- single-pass 回合恰好一次逻辑生成；bounded-feedback 回合恰好两次，永不产生第三次逻辑生成；
  adapter 私有的同模型有界 endpoint 尝试不算新的主体编排步骤。
- ContextProvider 并行执行且共享总截止时间；单个失败只省略其片段，不阻塞首次生成请求。
- `feedbackToolsEnabled` 关闭或 adapter 未实现 FeedbackTool 传输契约时不暴露 FeedbackTool；开启时不探测逐模型能力。
- 同一输入分别验证开关关闭时只产生 single-pass，以及开启且模型选择工具时只产生一次 bounded-feedback。
- FeedbackTool 不按读写、风险或幂等性分类；整批结果按 call ID 回传一次，最终请求将函数调用模式设为禁止。
- 运行时 unsupported 不降级为 XML，不重试、不探测也不切换模型。
- 整批 FeedbackTool 在执行前原子验证 call ID、Tool ID、输入、作用域和预算；非法批次执行数为 0。
- ActionTool 结果从不传给 adapter；任何 ActionTool 都不能递归触发当前回合的生成。
- `before-send` ActionTool 只执行低延迟允许项并受统一短超时；配置为 block-reply 的失败阻止发送。
- `after-send` ActionTool 不延迟消息；`deferred` 由有主作用域持有，完成后至多提交一个新 WakeProposal。
- 零个 message 时不发送；一至四个 message 不并发、不重排，逐段只发送自身文本及自身通过白名单校验的 quote。
- 任一段平台发送失败后停止后续段；已经成功发送的段不重发，也不伪装成可回滚事务。
- adapter、Tool、XML、超时和限流错误都不进入群聊。
- 生成后不重读频道；记录模型耗时与人为发送等待，二者分开统计。

## 5. 仿生能力增量

### YK-022 话题线程与场景理解

前置：YK-013、YK-020。

交付：维护有界 `ThreadState`，从当前快照产生话题、参与者、模式、指向性和“已有充分回应”特征。

验收：固定多话题回放样例中，回复归属正确线程；过期线程归纳或删除；场景计算不发起独立远程模型请求。

### YK-023 角色状态与成员关系

前置：YK-013、YK-022。

交付：持久化心境、社交精力、近期参与、未完事项和多维成员关系，并用有界纯函数更新。

验收：单次互动变化不超配置上限；熟悉度不等于单一好感度；离线后中期状态保留、短期状态按时间衰减；更新幂等且作用域隔离。

### YK-024 四类记事本笔记与回复后写入

前置：YK-013、YK-020、YK-021、YK-023。

交付：实现 episode/fact/relationship/self 四类笔记、来源追溯、作用域过滤、话题/对象/时间/重要度排序、纠正和过期，并以内置 `notebook.write` ActionTool 提供选择性写入。该 Tool 固定为 `after-send`，只执行最终 XML 明确提出的笔记，不另设自动记忆抽取调用。

验收：每次回复可提出零条或多条但不超过配置上限的笔记；只有角色消息成功发送后才执行写入，silence、发送失败和失效回合写入数为 `0`；写入结果不回灌 LLM、不触发新生成；无来源提案不入库；新纠正会降低或替代冲突旧笔记；低置信笔记不召回，中置信笔记带不确定标记；跨实例/群聊检索为空。

### YK-025 持续讨论租约

前置：YK-018、YK-021。

交付：在启用的真实 @ 或回复自身硬回复后建立有界 `EngagementLease`；角色名前缀/包含硬回复不开租。以宿主本地状态机实现开启、续期和关闭，并在租约有效期内
为参与者消息提交持续讨论 WakeProposal。租约状态不进入角色 XML。

验收：只有租约参与者可继续触发；同一参与者连续发来的多条入站消息合并为一个角色回合；
WakeArbiter 接受合并提案时恰好扣减一个剩余轮次，并将空闲到期时间更新为
`min(now + ttl, absoluteExpiresAt)`，绝对期限不可延长；未被接受或仅在 debounce 中合并的单条消息不扣减
轮次；`ttl` 和 `maxDuration` 为正数且 `ttl <= maxDuration`，`maxRounds` 为正整数；空闲到期、绝对期限、
剩余轮数归零、转话题和宿主显式关闭均可结束租约；结束后恢复普通门控，时间边界由 `TestClock` 验证。

### YK-026 持久化定时任务

前置：YK-009、YK-017、YK-018、YK-021。

交付：实现生成前 `schedule` ContextProvider、只读 `schedule.query` FeedbackTool、`schedule.create/update/cancel` XML ActionTool、最近任务调度器和 scheduled 响应机制。

验收：时区和宿主当前时间参与解析；query 结果只回传一轮，写动作不回灌模型；`dedupeKey` 防止消息重放和重复动作创建；重启恢复且每项最多触发一次；错过任务按 grace period 处理；仅消耗 reserved 预算。

### YK-027 ContextProvider/双 Tool/Skill/MCP 可见性与热插拔

前置：YK-009、YK-021。

交付：实现本地 Skill 与 ContextProvider 选择、ActionTool XML 模板、FeedbackTool declaration、两类可见列表/阶段/超时校验、MCP 显式分类投影与断线重连。

验收：冷路径不用远程模型选 Skill；ContextProvider 在首次生成前完成；回合只暴露配置可见且不超各自上限的 ActionTool 模板与 FeedbackTool declarations；MCP Tool 使用 `<server>.<tool>` ID，安装者必须显式选择投影为 ActionTool 或 FeedbackTool，未分类项不可见；主体不实现第三方工具风险、读写或幂等性分类；断线只移除该服务新快照中的能力，不影响其他能力。

### YK-028 受限主动发言

前置：YK-017、YK-021、YK-023、YK-024。

交付：从未完话题、高相关近期内容和低频角色内生动机生成 initiative 提案。角色内生动机仅基于人格兴趣、当前状态或已有自我记忆提供发言机会，不预写主题或正文；接受后角色可以自由发挥或保持沉默。

验收：默认不主动私聊；没有未完话题和高相关近期内容时，满足条件的角色内生动机仍能创建 initiative 回合；没有可审计的社会动机时不提案；频道冷却、关系阈值和 background 预算任一不满足时不创建回合。

## 6. 控制面与评测

### YK-030A 治理策略与持久预算内核

前置：YK-019、YK-027。

交付：实现供应商无关、版本化的 `GovernancePolicy` 服务，统一执行能力授权、入选优先级、宿主软预算和分类
逻辑调用预算，并提供后续可选 Console 插件后端使用的、仅进程内可注入的有权限查询、dry-run、CAS、审计和
回滚 control service。能力/预算策略、频道策略和
实例 active preset 各有唯一 active revision；active preset 的唯一运行时权威是版本化 `yokai_preset_state`，完整
不可变历史只用于校验、审计和生成新 revision，不参与运行时选择，也不是第二份 effective 状态。服务同时提供
宿主保留、第三方不可注册或伪造的 managed preset owner principal，以及该 owner 下可持久化、版本化且重启可恢复
的 `PresetSource` 存储；它归主体治理内核所有，Console 只是编辑客户端。文件和插件来源仍由各自 owner 管理。

YK-030A 必须可在完全未安装 `koishi-plugin-yokai-console`、Console 插件加载失败或随后被卸载的环境独立启动和
运行。首次安装由主体自动建立安全默认 policy、调用预算和 preset selection；各功能直接通过 Koishi model API
声明自身持久化模型，不新增跨任务数据库基础设施。注册表选择、预算 reserve/commit、回合执行、审计和 managed
preset 加载均不得等待 Console service、路由、静态资源或前端连接。没有 Console 时仍保留主插件原生 Config，
主体不在聊天平台注册任何管理命令，进程内 control service 也不自行暴露 HTTP/RPC。缺失的是逐项审批/调序、
细粒度预算编辑、dry-run 解释、预算 headroom 图表和回放查看能力，不是 Yokai 的存档、门控、生成、Tool、预算
执行或安全默认值。

空库 bootstrap 由主体在同一事务中幂等创建 `DefaultGovernancePolicyV1` active revision、频道策略、三类调用预算和
preset selection。默认策略按稳定顺序绑定并批准宿主保留的内置能力当前 host-proven fingerprint；新/变化第三方
能力继续 pending-review。主体升级导致内置 fingerprint 改变时，只能由随该主体版本发布、显式列出旧/新 tuple 的
builtin policy upgrade 审计升级，不能泛化为自动批准第三方。升级只替换与旧 tuple 精确匹配的内置授权身份、build
fingerprint 和 descriptor hash，创建新的 policy revision，并原样保留 enabled、grant 顺序、lower-only override、
频道策略、preset state 以及预算限额/窗口/用量；不精确匹配的项继续按普通 fingerprint 变化进入 pending-review。
已配置且唯一合法的 file/plugin preset 在无 Console 环境首次启动时解析为 `Resolved`；根本未配置 preset 时写入
`Unselected { reason: "not-configured" }`，已提供 ID 但来源缺失、无效或歧义时才写 `PendingIntent` 并只存档。
bootstrap marker 已存在但 active row 异常缺失时必须 fail closed，不能每次启动重灌默认值或清零预算。

YK-030A 的 control service 至少提供脱敏 status（policy/preset revision、selection kind、pending 数/reason、预算
窗口）、按宿主证明 source/version 从 `Unselected`/`PendingIntent` 恢复或选择 active preset、频道停用，以及只在
marker 存在而 active row 缺失时接受 expected marker/revision 的 `repair-active`。这些能力只由宿主注入给可选
Console 后端；全部经同一 control service、CAS 和审计，选择/恢复创建 `Resolved`
新 revision，repair 创建新 revision且不得修改预算用量。control service 不提供无界 descriptor 正文或 hash-only
grant approve 操作，因此无 Console 时新/变化第三方能力保持 pending，内置及既有已批准能力继续工作。actor
principal 与权限只能由主体/Koishi 边界注入，control DTO 或浏览器请求不能自报。

治理域覆盖 ContextProvider、Skill、ActionTool、FeedbackTool、MCP Server 及其已分类投影。为 ContextProvider
补齐与其他能力一致的实例级有序 allowlist。preset 和 Skill 只能请求能力，不能越过实例 grant 扩权；MCP Tool
必须同时命中 Server grant 与对应 ActionTool/FeedbackTool grant，允许 Server 不自动允许其当前或未来全部 Tool。
MCP 投影类型继续由能力源显式声明，主体不按名称、描述、读写性或风险推断或改写 Action/Feedback 类型，未分类
或未发布项保持不可见。

`GovernancePolicy` 至少包含以下经过 Schema 解码的规范化字段：

- 按 domain 分组的有序 `CapabilityGrant`。每项包含 `(domain, id)`、enabled、宿主证明的 `CapabilitySourceId`、
  `fingerprintVersion`、source build fingerprint、已批准 canonical descriptor/projection hash 和可选 lower-only
  override；数组顺序就是入选优先级。`CapabilitySourceId` 由宿主从 Koishi loader 的包身份和持久插件实例键派生，
  内置来源使用保留域，同包多实例必须可区分且热重载后保持稳定；能力描述符和 MCP payload 均不能自报或覆盖它。
  source build fingerprint 使用版本化 `BuildAttestationV1`：对根打包产物以及 loader-resolved runtime dependency
  closure 做 Merkle digest，每个 leaf 固定宿主证明的包身份与 registry integrity；本地/无 integrity leaf 使用
  deterministic package file-set digest。不能只 hash manifest、入口或根包 integrity。稳定来源 ID 与 build
  fingerprint 分离：热重载不改变来源 ID，但任一传递 helper/依赖变化必须改变 build；宿主无法覆盖动态依赖或闭包
  实现等完整 closure 时，该来源每次重新注册都进入 pending-review，不能降级为“沿用旧批准”，且不要求第三方
  插件修改注册协议。
- `TurnResourcePolicy`：`recentContext.maxMessages/maxTokens`；
  `contextProviders.maxSelected/perProviderTokens/totalTokens/deadlineMs`；
  `skills.maxSelected/instructionBytes`；
  `prompt.systemInstructionBytes`；
  `actionTools.maxVisible/perDeclarationBytes/totalDeclarationBytes/templateBytes/maxActions/beforeSendDeadlineMs`；
  `feedbackTools.maxVisible/perDeclarationBytes/totalDeclarationBytes/maxCalls/totalResultTokens/maxConcurrency`；
  `generation.maxOutputTokens/turnDeadlineMs`。ContextProvider/ActionTool/FeedbackTool grant 还可分别收紧其注册的
  maxTokens、maxDurationMs 或 maxResultTokens。
- `CallBudgetPolicy`：`reserved/normal/background` 各自的 minute/day 逻辑调用限额和日窗口 IANA 时区。minute 合法
  范围为 `0..10_000`，day 为 `0..1_000_000`；默认时区 `UTC`，三类默认值依次为 `6/200`、`2/100`、`1/20`。
- 既有 wake debounce/阈值/冷却、讨论期限/轮次、历史/记事本召回、定时上下文和数据保留限额；这些仍使用同一
  规范化策略入口，不在任何可选客户端另造同名字段。

`TurnResourcePolicy` 除下述显式 declaration 安全收紧外，其余默认值保留当前运行时行为，最大值不得超过以下
硬上限：recent context 的
`maxMessages` 范围为 `20..80` 且默认 40，`maxTokens` 默认为 4096；
ContextProvider 为 8 项、单项 2048 token、总计 4096 token、共享 400 ms；Skill 为 4 项和 16 KiB；
ActionTool 为可见 16 项、单个 canonical declaration 64 KiB、declaration 总计 64 KiB、模板总计 16 KiB、system
instruction 64 KiB、每回合动作 8 项、before-send 750 ms；FeedbackTool 为可见 16 项、单个 canonical declaration
64 KiB、declaration 总计 64 KiB、每批调用 4 项、总结果 8192 token、并发 4；模型输出 1024 token，总回合 45 s。
这些 declaration 数值是有意新增的安全 exposure 默认/硬帽；升级时已注册且合法但超过 64 KiB 的能力继续注册并
保留 grant intent，但以 `declaration-*-byte-cap` 变为 budget-hidden；主体治理状态/诊断快照必须包含告警，可选
Console 安装后显示同一告警，不能宣称完全保留旧暴露行为。它们不改变现有注册协议。协议根据当前 Portable
Schema、description
和 template 的有限字段上限生成并发布每个 protocolVersion 可编码的 `maxEncodedDeclarationBytes` 注册硬帽；只有
违反协议硬帽才拒绝注册/投影，合法但超过回合 per-item/aggregate cap 的能力保持 registered、按 grant 顺序整体
省略，不能截断 Schema。declaration 字节按同一版本化 canonical 编码的 UTF-8 字节计算，覆盖 description、portable
Schema（含字段 description）、Action XML 模板和其他实际 host→model DTO/渲染字段；FeedbackTool outputSchema 只在
宿主校验结果，不计入模型 declaration exposure bytes，但仍进入完整 descriptor fingerprint 与协议注册硬帽。省略
返回 `declaration-item-byte-cap` 或 `declaration-total-byte-cap`，不能只凭“最多 16 项”规避请求膨胀。
当 ActionTool 或 FeedbackTool 候选数超过 `maxVisible`（平台硬上限均为 16）时，不拒绝注册，也不在同一回合分页或
动态检索更多 Tool；只按 grant 优先级选择前 N 项，其余以 `count-cap` 省略。策略管理员可通过同一 control service
调序或停用；可选 Console 只提供可视化客户端，任何客户端都不能用提高 soft limit 越过 16 项硬帽。
具体数值由后端共享契约/运行时定义发布，前端不得复制常量。`TurnResourcePolicy` soft limit 必须为正且只能收紧
对应注册声明和硬上限，effective 值固定为全部适用上限的最小值；停用能力使用 grant/global switch，不用非法的
零资源预算表达。分类调用预算仍允许把某一类别显式配置为 `0`。

治理服务以“协议硬上限 → 扩展注册上限 → 宿主软上限 → 当前回合剩余额度”计算并返回结构化 effective 数量、
token、字节、耗时、并发、使用量和 headroom。最近消息、Provider context、preset/Skill/system instruction 和
生成输出仍是分别实施的预算区段；在没有统一 tokenizer 和完整请求计数前，不得把分段估算宣称为模型总上下文
保证。模型 token 上限、Tool Schema、Action 阶段/完成/失败策略和扩展声明上限只能作为只读输入，不能由 policy
放宽。

现有 `capabilities/callBudget/wake/engagement/notebook/schedule/state/messageRetentionDays` 配置只在首次 bootstrap
时导入一次：导入逐项保留数组顺序、显式值和旧默认语义并写入完成标记。legacy `presetId` 同期一次性导入版本化
`PresetSelectionState`：从未配置 preset 时写入 `Unselected { reason: "not-configured" }`；来源已唯一且有效时写入
`Resolved { presetId, sourceId, version, hash }`；提供了 preset ID 但来源尚未注册、invalid 或存在歧义时写入
`PendingIntent { presetId, expectedHostSourceHint?, reason }`，不得丢弃 ID。`Unselected` 和 `PendingIntent` 期间继续
本地存档但禁止模型回合；前者只可由管理员按 expected revision 显式选择宿主证明的 source/version，后者只有匹配
宿主证明 source hint 的有效 last-good 出现才可原子解析，否则也必须由策略管理员显式选择，第三方同名 source 不能
抢占。三种状态都只存于 `yokai_preset_state` 并具有 revision/CAS/审计；建立后运行时不再读取 Config 中的
`presetId`。上述 legacy 字段从主插件 Schema 移除或变为 bootstrap-only 只读视图，普通配置 reload 不得再次
bootstrap、重新批准 fingerprint、切换 active preset 或覆盖 active revision；
运行时只读取对应唯一权威。`model`、`feedbackToolsEnabled`、实例身份和 preset source 路径继续属于原生 Config，
不进入 GovernancePolicy CAS，但它们自己的配置 revision 必须冻结进 turn snapshot。

所有 policy、active preset 和 host-managed preset 编辑入口，包括可选 Console 经 control service 发起的编辑与
回滚，都经过同一服务端 decode → normalize → fingerprint validation → CAS → security audit 流程。CAS 只比较对应 expected
revision，并针对被编辑 grant 验证当前 fingerprint；registry revision 只进入审计，避免无关 MCP 重连阻塞预算
保存。成功提交、完整不可变 normalized revision 和安全审计 append 使用同一事务或可靠 outbox，任一步失败均不
切换 active revision。审批/拒绝、grant 编辑、预算/频道变更、active preset 切换、回滚、preset-editor body 读取、
descriptor-review 分页读取、Replay 读取/导出和密钥管理的成功与失败尝试都追加不可变安全审计，至少记录 actor
principal、instance、动作、授权结果、时间、requestId、前后 revision/hash、source/fingerprint/page、脱敏 diff 与
结果 reason；API key、secret reference 值、正文、prompt、Schema、模板和 Tool input/result 不得进入审计。任何
敏感读取必须先成功 append 审计再返回正文，审计不可用时 fail closed。无权限请求必须零治理状态写入，但安全审计
append 是明确例外且不能被伪装为成功事务。YK-030A 直接使用 Koishi model API 声明 active policy、完整 revision
历史、安全审计、active preset、host-managed preset 版本、频道策略、调用预算窗口和在途 reservation 的持久化
模型；历史不是可独立执行的配置副本。

`fingerprintVersion` 同时固定 canonical 编码与 digest 算法；v1 使用 RFC 8785 JSON Canonicalization Scheme 对
精确定义、经 Schema 规范化的 descriptor DTO 编码并计算 SHA-256。算法升级必须通过显式 policy upgrade 写入新
version，不能伪装成普通 descriptor 变化或把旧 hash 当作新算法结果。canonical descriptor hash 覆盖全部规范化、
模型可见及权限相关字段，包括 protocolVersion、description 及
portable Schema 内 description、Skill 选择规则/依赖引用/prompt hash、ContextProvider 选择与资源声明、ActionTool
完整 XML template/阶段/完成/失败声明、FeedbackTool 输入输出与结果声明，以及 MCP projection 的
server/name/type/完整投影描述；排除密钥、函数闭包、连接状态、时间戳和易变 registration generation。有效授权
绑定 `(domain, id, host-proven CapabilitySourceId, BuildAttestationV1 fingerprint, fingerprintVersion, approved
descriptor hash)`；任一不符
一律成为 `pending-review` 并从每个新回合的 effective allowlist 排除，直至策略管理员重新批准。首次 bootstrap
旧字符串 allowlist 时，在线项绑定当前 fingerprint；离线项保留为 dormant unresolved intent，重新出现后必须批准；
已有内置 ContextProvider 按当前行为导入，第三方新能力默认不可见。

能力和资源策略成功保存后只影响新开始的回合，进行中回合继续使用冻结策略与能力快照。调用预算限额则立即
约束尚未发生的 reservation：已预留的逻辑调用不受降额影响，但在途 bounded-feedback 回合尚未预留的第二次
逻辑调用可能被新限额拒绝并静默结束。每个 reservation 使用稳定 reservationId，并同时固定 minuteStartedAt 和
dayLocalDate；状态机保持 `reserve(pending) → commit-before-provider-I/O(committed)` 或
`release-before-provider-I/O`，不新增 dispatched-but-uncommitted 状态，三项操作均按 reservationId 幂等。调用
adapter 的必要前提是调用方已经观察到 durable committed；commit 返回 false、明确数据库错误或超时/结果未知时
一律 fail closed、零 provider I/O 并保持角色内沉默。结果未知只能用同一 reservationId 重试/读取来协调；无法证明
committed 时不得调用 adapter，也不得贸然 release 可能已经 committed 的记录，由恢复流程保守结算并留下控制面
reason。崩溃恢复释放可证明仍为 pending 的记录，committed 保持计费。降低限额不取消 pending 或冲销 committed；
时区变更只在旧时区当前 day window 的下一边界生效，不得借 reload、重启或改时区提前清账，也不提供重置额度
按钮。

验收：

- 首次 bootstrap 黄金测试逐项保留已有四类 allowlist 的 ID/顺序，并按 bootstrap 时既有内置 Provider 行为合成第五类
  ContextProvider grant；内置 Provider 暂时离线仍保留 dormant intent，第三方 Provider 默认隐藏。测试同时保留三类
  调用预算、wake/engagement/notebook/schedule/state/retention 的显式值与默认行为，并将 legacy `presetId` 导入
  `yokai_preset_state`。bootstrap 只执行一次；升级后重启恢复 host-managed preset 与 active preset，reload 旧字段不能
  覆盖唯一 active state 或重新批准能力。来源晚注册、invalid、同 ID 歧义与恶意同名来源测试均保留
  PendingIntent 并禁止生成，只有宿主 source hint 精确匹配或管理员 CAS 选择后才解析。已有合法但超过新增
  declaration exposure 帽的能力保持 registered/granted intent、变为 budget-hidden，并在主体治理状态/诊断快照中显示告警；
  安装可选 Console 后读取并显示同一状态。
- 无 Console 首次安装未配置 preset 时原子创建 `Unselected` revision 并继续存档；control service 状态快照返回
  selection kind/reason。安装可选 Console 后，授权管理员以 expected revision 选择宿主证明 source/version，状态原子
  转为 `Resolved`；过期 revision 或伪造来源均零状态写入。不存在把“未配置”编码为缺少 `presetId` 的
  `PendingIntent` 的隐式状态。
- 内置、安装包、本地插件热重载和同包多实例产生稳定且适当区分的宿主 `CapabilitySourceId`；调用方伪造 source
  字段无效。`BuildAttestationV1` 测试覆盖 registry-integrity 与本地 deterministic file-set leaf、完整 loader-resolved
  transitive Merkle closure，以及入口不变但 helper/外置依赖变化仍改变 build；canonical descriptor v1 有 test vector
  和显式算法升级。source build、任一模型可见/权限相关 descriptor 字段或 MCP projection 改变后，每个新回合都
  把旧 grant 判为 pending-review；相同 fingerprint 的断线重连不要求重复批准，无法证明完整 closure 的重新注册
  不会沿用旧批准。零修改第三方插件通过对应兼容测试。
- 先通过可选 Console 修改内置 grant 的 enabled、顺序和 lower-only override 以及频道、preset、预算设置，再卸载
  Console 并升级主体；显式 builtin policy upgrade 只替换精确匹配的旧 fingerprint tuple，生成可审计新 revision，
  上述设置和预算窗口/用量逐项保持。旧 tuple 不精确匹配或第三方来源不得被升级自动批准。
- 能力对象以 `(domain, id)` 标识；有效能力固定为注册 fingerprint、enabled grant、preset/Skill 请求、MCP 双重
  grant、scope availability 和资源预算的交集。grant 数组顺序决定准入优先级；ActionTool 最终按 ID 稳定渲染
  不改变优先级。
- 已有 dormant 未注册 grant 保留但永不 effective；新增 enabled grant 或 lower-only override 必须绑定当前已注册
  fingerprint。preset/Skill 发布时的结构性悬空引用继续拒绝，旧离线 intent 不阻止无关预算保存。
- 重复/非法 ID、超过每域配置上限、新增未知 enabled grant、soft limit 越过注册/协议上限或过期 policy revision
  及无权限请求均原子失败、零治理状态/历史 revision 写入，但必须追加失败安全审计。故障注入证明 active revision、
  完整 normalized revision 与成功审计记录原子提交；rollback 总是按当前 fingerprint 重验并创建新 revision，不
  改写历史。固定 managed owner principal 不能被第三方同 ID 注册、抢注或伪造。
- 所有 count/token/byte/ms/concurrency 字段使用有界正安全整数，`recentContext.maxMessages` 单独限制在 `20..80`；
  CallBudgetPolicy 接受记录的 `0` 与最大值边界。effective resource limit 等于 policy、注册声明、协议硬帽和模型
  上限中全部适用值的最小值。
- 资源预算保持分域语义：ContextProvider 超限/超时省略相应 fragment；Skill/Action/Feedback visibility 与
  declaration 上限按 grant 顺序确定性裁剪并返回稳定 reason，超过回合单项上限的合法 declaration 保持 registered
  但不 exposed，只有违反 protocolVersion 生成的注册硬帽才拒绝注册/投影；FeedbackTool 的 call 数或声明结果额度
  超出批次预算时执行数为 `0`，实际输出超项、Schema 失败或超时形成有界 failure result；
  `actionTools.maxActions` 超限使 envelope 原子 parse-fail；ActionTool 的单项或 before-send 超时继续按 execution
  stage 和 failurePolicy 产生 continue/block-reply，after-send/deferred 只记失败。
- `generation.maxOutputTokens` 只约束 provider 请求；命中 length finish 后若文本仍是完整合法 XML 可继续成功，只有
  XML/结构校验失败、mandatory system prompt 无法编译或 `generation.turnDeadlineMs` 到期才使本回合沉默失败。
- `TestClock` 与重启恢复测试覆盖 minute/day 翻转、reserve/commit/release、崩溃释放 pending、保留 committed、
  限额下调和旧时区下一日边界切换；已占用超过新限额时 remaining 为 `0`，新 reservation 被拒绝且不会跨类别
  借额。故障注入覆盖 commit false、事务错误、响应丢失/超时及同 reservationId 重试：除可观察 committed 外均为
  零 provider I/O，未知结果不会双扣或错误 release，并产生控制面证据。single-pass 只提交一次，bounded-feedback
  至多两次。
- 能力/资源 revision 只影响新回合；CallBudgetPolicy 变更立即约束尚未 reserve 的调用，包括在途回合可能发生的
  continuation。所有错误保持角色内沉默，策略、预算和 bootstrap/upgrade 诊断只进入控制面。
- 无 Console 集成测试在依赖树和 Koishi 配置中完全不安装/启用 `koishi-plugin-yokai-console`：fresh DB 原子创建
  `DefaultGovernancePolicyV1`、内置 grants、预算和 Unselected/Resolved/PendingIntent preset state，legacy Config
  bootstrap 只执行一次；合法
  preset/model 下覆盖存档、direct/activity 唤醒、single-pass、bounded-feedback、内置 Action/Feedback 执行和预算
  拒绝。Console 缺失不是错误或 preset pending reason；缺席期间新增/变化第三方保持 pending，内置及相同
  fingerprint 的既有批准继续 effective。
- Console 卸载前已提交的 policy、grant 顺序、预算 limit/pending/committed/window、active/host-managed preset、
  审计和在途回合状态在卸载后保持有效；主体不重启、不回退默认值、不改变时区边界也不中断消息处理。fresh、已有
  当前 schema 和重复启动的治理初始化均由主体在没有 Console package/node_modules 的测试中完成。

### YK-030B 独立可选 Console 增强插件

前置：YK-011、YK-030A。

交付：新增 `plugins/yokai-console` 工作区和独立发布的 `koishi-plugin-yokai-console` npm 包，并只在该 workspace
接入 `yakumo.yml` alias、客户端构建和 Console 依赖。它通过 Koishi service injection 使用 YK-030A 发布、带显式
`controlProtocolVersion` 的 control service，并提供有权限的后端路由与 Koishi Console 页面；页面
分为能力目录、有效回合预览、预算与门控、安全上限、预设/频道策略和运行状态。该插件不持有独立 allowlist、
优先级、soft limit、预算账本、数据库表或持久化实现，也不直接访问 Yokai 表。

依赖方向固定为 `koishi-plugin-yokai-console → yokai-protocol/Koishi + ctx.yokai control service`；Console 可声明
`koishi-plugin-yokai` 为 peer/runtime requirement，但主体的 package manifest、源码和产物不得依赖、动态 import、
探测包名或打包 Console。Console 不导入 `@yokai-internal/core/mind/memory`，control DTO 与错误 Schema 位于
`yokai-protocol`。control protocol major 不兼容、Console 后端/前端加载失败时只停用增强插件并报告角色外错误，
不得阻止主体启动或消息回合。

Console manifest 以 `koishi`、`@koishijs/plugin-console` 和 `koishi-plugin-yokai` 为 peer/runtime requirements，后端
只在 `yokai` 与 `console` service 均可用时激活；客户端构建依赖留在 Console workspace。YK-031 的 evidence/replay
能力通过 control service 的 `governance/preview/model-directory/telemetry/replay` feature bitmap 协商：尚未实现或
minor 版本不支持时只隐藏对应页面并显示 unavailable，不把 YK-031 变成 YK-030B 的硬前置，也不尝试直读数据库
补齐。Console apply/启动自身为零业务状态变更：不得 bootstrap policy、创建 revision、重置预算、触发
`discoverModels`、注册能力或注册 `PresetSource`，只订阅并 hydrate 主体现有快照；所有变更必须来自授权用户的
显式操作。

能力目录列出 ContextProvider、Skill、ActionTool、FeedbackTool、MCP Server 和已分类投影的宿主来源、source
build、协议版本、registration generation、descriptor hash、MCP revision/连接状态、preset/Skill 引用、固定执行
属性及资源声明。管理员可逐项启停、批准 fingerprint 并调整 grant 数组的准入顺序。MCP 投影发布的 description、
Schema 和模板是会进入模型的特权 descriptor，必须经过 fingerprint 审批；远程返回数据仍是不可信数据。Console
不重分类 MCP Tool，也不提供 Server wildcard。

有效回合预览按实例、preset、频道作用域、管理员提供的模拟冻结 focus、事件类型和响应机制调用同一纯选择核心，
展示
`registered → granted → requested/matched → MCP allowed/connected → available → budget-selected`、headroom 和
稳定 reason code。唯一允许调用的扩展 callback 是协议保证同步且无副作用的 `isAvailable`，并且每项至多一次、
异常隔离、结果标为 point-in-time；`provide/prepare/isInputAllowed/execute`、模型请求和远程 MCP 一律不调用，也不
创建 WakeProposal 或 reserve 预算。最终 prompt headroom 等无法静态确定的结果标为“回合时判定”。

预算页展示 resource policy 的 configured/registered/hard/effective 值，以及三类 minute/day 调用预算的
limit/pending/committed/remaining 和下一翻转时间。安全上限和默认值由治理后端共享定义发布，前端不复制常量，
也不把各 prompt 区段估算冒充统一模型 context budget。adapter 私有 endpoint、key、timeout、并发和 retry 不进入
通用 Console；页面只显示通用 adapter/模型目录状态并跳转到对应插件原生配置。模型选择与
`feedbackToolsEnabled` 保留在主插件原生表单，Console 只显示它们自己的 effective revision 和定位入口。

Console 以 Koishi 服务端认证的人类 actor 调用 YK-030A 的 `editManagedPreset`；保留的 managed owner principal
始终封装在主体内，由主体代写 owner 并按真实 actor 审计，不能返回给 Console 或接受浏览器自报。managed
`PresetSource` 由主体常驻发布；
file/plugin-owned preset 只读，仍由原 owner 负责 Schema/引用校验、last-good、version/hash 和新版本回滚。切换
active preset、频道停用和所有 policy 写入均调用 YK-030A 对应的 CAS/安全审计服务，active preset 页面只读写
`yokai_preset_state`，不得回写 legacy Config。YK-031 完成后在相同页面追加真实回合证据、token/成本和历史聚合；
YK-030B 本身只依赖 control service 返回的当前治理快照、预算账本和模型目录即可验收；卸载后这些状态继续由主体
持有并执行。

普通清单/预览路由只返回 preset 元数据。独立的高权限 preset-editor read/write 路由只可读取和修改 host-managed
preset body，必须执行来源 owner 校验、CSRF 防护和 expected-version CAS；file/plugin-owned body 不得通过该路由
读取。preset 正文可以返回给获准的编辑器，但不得进入浏览器持久缓存、普通 RPC、日志、安全审计 diff 或错误消息。

能力审批使用独立只读、高权限 descriptor-review 路由。它只读取当前 registered/pending fingerprint 对应的
canonical descriptor，以固定 64 KiB UTF-8 byte page 返回审批专用 code-point view，并在每页绑定 domain/ID、宿主 source/build、
fingerprintVersion、descriptor hash 与 registry revision；MCP/第三方 description、Schema、Skill prompt 和 XML
template 只转义显示，禁止作为 HTML 执行；bidi override/isolate、零宽字符和其他不可见/control code point 必须显示
为 `\u{...}`，页面同时标注原始 UTF-8 byte offset/边界，并使用严格 CSP/no-store。批准请求仍只提交该绑定 tuple 与
expected policy revision，由服务端重验当前 registry；正文不进入批准请求、日志或审计。普通清单不能读取
descriptor body；批准请求要求 principal 同时具备 `descriptor-review` 与 `policy-approve`，review-only 不蕴含
approve，而任何 policy-approve 角色必须包含 review 权限，避免只有 hash 可看的盲批或借查看权限直接批准。

所有非幂等 Console 路由及可能触发外部 I/O 的运行操作统一使用宿主 anti-CSRF token 与 Origin 校验，只接受对应
权限下的非 GET 请求；覆盖 preset write、grant approve/enable/reorder、policy/budget/channel/active-preset CAS、
回滚、key 管理和手动 `discoverModels`。descriptor/preset/Replay 等敏感读取同样校验同源并按 YK-030A 先审计，不能
依赖浏览器默认行为作为权限边界。

验收：

- 清单区分 registered、granted、requested、matched、MCP connected、available、pending-review、dormant 和最终
  exposed；配置离线、来源/hash 变化、MCP 断线或 adapter 不支持 FeedbackTool 时显示原因，不自动删除或批准。
- 拖拽顺序与运行时准入顺序一致，不把 ActionTool 最终 ID 渲染顺序误称为优先级。MCP 页面按 Server 与投影 Tool
  分层管理；新增/变化投影默认 pending-review，允许 Server 不会启用全部 Tool。
- 预览与运行时对同一冻结输入产生相同候选顺序和可静态判定的结果，并显示 `not-granted`、`not-requested`、
  `skill-not-matched`、`mcp-hidden`、`mcp-disconnected`、`fingerprint-changed`、`availability-error`、`count-cap`、
  `token-cap`、`declaration-item-byte-cap`、`declaration-total-byte-cap`、`template-byte-cap`、`system-prompt-cap` 等
  原因；不同的 reject-batch、failure-result、turn-fail 和 budget-deny 不统一伪装成“截断”。
- 预算页完整显示当前调用窗口和分域 resource headroom；保存 lower-only override、限额降级和时区变更前明确
  预览影响，在途 continuation 可能受新调用预算影响的例外必须可见，不暗示所有冻结回合都不受预算变更影响。
- 重复/非法 grant、越界 soft limit、过期 revision 和无权限保存由服务端原子拒绝；多页面并发不能静默覆盖。
  回滚只生成新 revision，不撤销已发消息、已执行 Tool/MCP 副作用、committed 用量或已发生费用。
- host-managed preset 可经 Console 热更新和发布新回滚版本；外部 owner preset 不出现可编辑按钮。非法版本保留
  last-good，
  切换 active preset 与能力授权仍是两个独立且相交的状态，不因 preset 引用自动扩权。
- 状态页与主插件表单读取同一模型目录快照；用户可查看最近发现成功/失败并手动刷新，刷新不阻塞消息存档；
  已配置但不可用的模型只警告，不自动改写。
- 能力列表、预览与预算查询除受限 `isAvailable` 外不调用扩展 callback。只有用户显式执行“刷新模型目录”这个
  独立运行操作时，才可调用 adapter 的 `discoverModels`；它不得调用 Provider/Tool/MCP、创建角色回合或消费角色
  分类调用预算。服务端至少区分只读、运行操作和策略管理权限；Skill/preset 编辑、grant 批准和预算上调需要
  策略管理权限，失败请求及 Replay 相关操作按 YK-030A 安全审计契约记录。
- 普通页面/RPC、审计和浏览器日志不返回 API key、continuation handle、完整群聊/prompt/Skill prompt、XML 模板、
  Tool Schema/input/result 或 adapter 私有配置；唯一例外是高权限 preset-editor 路由可向当前编辑会话返回
  host-managed preset body，descriptor-review 路由可分页返回当前 fingerprint 的 canonical descriptor。两条例外
  路由的权限、owner/source、CSRF/Origin、fingerprint/CAS、UTF-8 分页边界、HTML 转义、bidi/zero-width/control
  code-point 显式显示、CSP 和 no-store 行为均有正反测试；descriptor 在审阅后变化会使批准失败。全部非幂等和
  外部 I/O 路由通过统一 anti-CSRF 契约测试。技术错误不发送到群聊。
- 独立包门禁证明主体在 Console 包不存在时可单独安装、构建和通过 headless 端到端测试；扫描主体依赖树与产物，
  不得出现 `koishi-plugin-yokai-console`、`@koishijs/client` 或 Console 路由/资源。运行中安装 Console 可从 control
  service 重建全部页面状态；卸载只注销自身路由、静态资源和订阅，不删除/重置 policy、preset、预算、审计或
  replay，也不 dispose 主体 fiber。卸载后再安装可从持久状态无损恢复，重复装卸无监听器泄漏。

### YK-031 调试指标、治理证据与成本回放

前置：YK-018、YK-021、YK-027、YK-030A。

交付：分别记录活跃度分布、触发原因、合并数、逻辑生成数和 adapter 可选的供应商物理 endpoint 尝试数，以及
single-pass/bounded-feedback 路径、FeedbackTool 批次与结果 token、ContextProvider 查询、XML 解析、
ActionTool 阶段、费用、模型耗时、编排耗时和人为等待。每个普通角色回合同时记录 protocolId、registry/policy
revision、preset version/hash、scope/focus kind、可见消息数量、预算类别与准入/结算状态，以及有界的
ContextProvider/Skill/ActionTool/FeedbackTool/MCP 候选、入选顺序、最终暴露 ID 和省略 reason code；由主体 control
service 提供有权限的脱敏决策明细与离线回放查询，可选 YK-030B Console 只负责展示。预算拒绝、冷却、过期和
合并丢弃发生在 `yokai_turn` 创建前，
单独写入有界 `yokai_admission_attempt` 并在成功时关联 turn ID，不能伪造空回合记录。

普通 `yokai_admission_attempt` 只保存 content-free、Schema 有界的 `AdmissionProposalSnapshot`：mechanism/proposal
kind、去重后的 bounded 非内容 reason/candidate ID、scope kind、focus kind、预算类别、
activity/relevance/cooldown/lease 数值输入、minute/day budget-before snapshot、Clock/随机输入和最终
decision/reason；不得保存或返回 scope/focus/content/callback/Action input 的裸 hash、作者、消息 ID、quote、完整
scope 或正文，被接受时只用随机 attempt ID 关联 turn。普通 `yokai_turn` 保存调用预算
reserve/commit/release、窗口前后快照，以及能力 callback 的 capability ID、实现 fingerprint 和布尔/有界错误
outcome；不得保存 callback 输入、Action 参数或其可字典枚举的摘要。`isAvailable` 与
`ActionTool.isInputAllowed` 是不可持久化闭包，回放只能核对录制 outcome，不能调用当前插件重新计算。

精确 XML 回放另存于 `yokai_replay` 的 `ReplayEnvelope`：冻结 event kind/response mechanism、focus/scope/quote
白名单、完整规范化治理快照、各域有序 grant、有效 `PresetSnapshot`（含 source/version/hash、编译指令正文与实测
字节）和 Skill 请求；同时冻结 `feedbackToolsEnabled`/Config revision、所选 ModelRef、model-directory revision、
adapter/model 的 Feedback transport capability 与 token/resource limits，以及 MCP server connected/published
revision。载荷还包含 ContextProvider 输出、ContextProvider/Skill/ActionTool/FeedbackTool/MCP projection 中实际
参与编译/暴露项的 canonical serializable descriptor snapshot，并为每个进入纯选择核心的其他候选保存足以重算的
canonical selection DTO（规则、依赖/引用、资源声明、连接/投影状态、实测字节/token；不含闭包），不能只存录制
reason。另保存录制 callback outcome、最终原始 XML 和 Action 参数；函数闭包、adapter 私有配置和 secret 除外。
这样源、Config、模型目录或 MCP 状态改变后仍能离线重算选择和 headroom，且不把正文或 Tool input 复制到普通
turn/admission 表。任何候选输入使完整载荷超过 Replay 硬帽时，整条记录标记 replay-unavailable，不能保存部分输入
却宣称精确回放。

YK-031 定义窄接口、可注入且 scoped 的 `ReplayKeyProvider` Effect service：`current()` 返回 `{ keyId,
nonExportableAeadKeyHandle }`，`resolve(keyId)` 只返回当前或保留期内 retired key 的不可导出 handle。Koishi 边界从
只保存 `current keyId → secretRef` 与 retired read-only `keyId → secretRef` 的脱敏 keyring 配置构造该服务；raw key
不得进入应用 Config、数据库、配置导出、日志、审计或 RPC，secret reference 也不得通过通用 Console/RPC 导出。
keyId 是 host-global、永久不可复用的 key material 身份：首次解析时把内部 SHA-256 key commitment 与 keyId 原子
绑定并永久保留非 secret tombstone；同 keyId 重绑不同 material、同 material 别名为另一 keyId，或跨实例绕过别名
检查都拒绝。轮换只能新增全新 keyId/material 并把旧映射置为 retired-read-only，不能修改旧绑定；共享同一 keyId
的实例仍使用全局 nonce 唯一约束。没有 provider/current key 时维持 `replay-unavailable`，不阻断角色回合。

生产 Layer 另定义窄 `ReplaySecretResolver.resolve(secretRef)`，只把 secret reference 解析为内部
`{ nonExportableAeadKeyHandle, keyCommitment }`；MVP 唯一内置 scheme 为 `env:<VAR_NAME>`，环境变量值必须是
canonical base64url 编码的 32-byte AES key，缺失、格式错误、长度错误和不支持 scheme 均返回类型化
`SecretUnavailable`。commitment 只供 key-binding/unique constraint，不能进入通用日志、审计或 RPC。keyring
reference 保存在主插件
host-only、导出时脱敏的 native 配置区；生产 Layer 在 Koishi 外层作用域启动时读取环境变量、以
`extractable: false` 导入 WebCrypto key 并尽快清零暂存字节，应用层只见 handle。契约测试使用 fake resolver Layer，
生产测试覆盖 env Layer、脱敏导出、缺失/畸形值、scoped 释放，以及 alias/rebind/retire 的原子拒绝与重启恢复。

YK-031 为加密回放增加 lower-only `ReplayResourcePolicy.maxPlaintextBytes`，默认和平台硬帽均为 1 MiB；v1 禁止压缩，
密文列硬帽为 plaintext 帽加固定 AEAD/envelope overhead。写入前以有界 encoder 预检，读取时先校验密文长度再解码；
任何超限都只记 `replay-unavailable: envelope-byte-cap`，不保存截断的“精确回放”或任何明文。未来若引入压缩，必须
先定义 decoded-size 帽并通过 compression-bomb 测试。

v1 载荷使用 AES-256-GCM（`tagLength = 128` bit）AEAD envelope
`{ version, replayRecordId, keyId, nonce, ciphertext, tag, createdAt, expiresAt }`。每次加密使用 96-bit CSPRNG nonce，并以
数据库 `(keyId, nonce)` unique constraint 保证同一 key 下唯一；碰撞只允许有界重试，耗尽则记录
`replay-unavailable`。AAD 使用 versioned、length-delimited canonical tuple 精确编码
`(instanceId, replayRecordId, version, keyId, createdAtEpochMs, expiresAtEpochMs)`，解密后还要核对载荷内同一身份字段，
禁止跨实例、跨记录替换或篡改保留期。默认保留 7 天、可配置上限 90 天；新写入使用 current key，旧 key 只为
保留期内读取。写入时 key/安全 nonce 不可用只记录 `replay-unavailable` 且绝不落明文，不阻止角色回合；读取时
key 缺失/未知、数据库发现重复 nonce、认证失败、身份不符或载荷篡改一律 fail closed 并追加安全审计。envelope
Schema 只接受 canonical base64url，且在解密分配前严格校验 32-byte key、12-byte nonce、16-byte tag 和 ciphertext
长度；短 tag、宽松 base64 及非 v1 长度一律拒绝。

YK-031 直接使用 Koishi model API 声明/扩展 `yokai_admission_attempt`、`yokai_replay`、host-global replay key
commitment/tombstone 及 `yokai_turn` 的证据列、索引、外键、key commitment/keyId unique constraint、
`(keyId, nonce)` 唯一约束和保留期清理。测试必须覆盖 fresh DB、已有当前 schema 和重复启动，并保证不会因缺少
replay key 把敏感字段写为明文。上述模型、遥测写入、ReplayKeyProvider 和 retention job 全部由主体拥有；构建与测试不得
安装 YK-030B。无 Console 且 key 可用时仍写完整 envelope；key 不可用时仍按 `replay-unavailable` 运行，Console
装卸不得删除 envelope、key meta 或改变清理计划。

验收：存在完整 ReplayEnvelope 时，固定 Clock/随机服务可重现门控、预算准入、能力顺序、选择集合、裁剪原因、
XML 结构、Tool ID/Schema 和 quote 白名单结果；录制后即使 preset/source、Config、模型目录/limit、adapter Feedback
能力或 MCP 连接 revision 改变，结果仍不读取当前状态。动态 availability/input authorization 只核对录制 outcome，
不重新执行闭包；Replay 不可用时明确只提供聚合证据，不宣称精确回放。可断言 single-pass 逻辑生成数为 1、
bounded-feedback 为 2 且无第三次逻辑生成。每次 turn 记录
reserve/commit/release、minute/day 前后快照，以及各 count/token/byte/time/concurrency 预算的
limit/used/truncated/timeout；deny 只由 admission attempt 记录。

汇总单次路径比例、反馈工具率、能力裁剪率及原因分布、XML 有效率、唤醒到请求发出 p95、XML 编排 p95、模型
耗时、人为等待、每 100 条消息回合数和每千条成本。physical endpoint attempts 是 adapter 可选遥测，未提供时为
`unknown`，不能推断为 `1`，也不影响第三方 adapter 兼容或回合执行；协议允许缺失的 token usage 同样保持
`unknown`。token、endpoint 尝试和可归因费用在 YK-031 完成后进入主体 control service，并在安装 YK-030B 时进入
Console；缺少可信版本化价格、币种
或供应商用量时费用为 `unknown`，不能按 `0` 计算或把调用次数额度宣称为货币硬预算。货币硬封顶需另行定义价格
来源、预留和结算协议。可选 Console 页面追加 replay retention/maxPlaintextBytes 的 configured/hard/effective 值、
key availability/rotation 状态和 `replay-unavailable` reason，但绝不返回 key/ref；未安装 Console 不影响记录、
清理或 control service，调整仍走 GovernancePolicy CAS 与安全审计。

离线回放不读取当前 registry/config、不调用 Provider/Tool/MCP、不执行动作、不重新预留预算，也不能获得录制
回合之外的动作或引用权限。普通 control service/Console/日志只返回 ID、非内容 descriptor/policy hash、计数、结果状态和
reason code，绝不返回 scope/focus/callback/Action input 的 hash；ReplayEnvelope
读取/导出需要单独高权限，成功和失败均记录 YK-030A 定义的安全审计。`TestClock` 覆盖 7/90 天边界和清理；测试
覆盖 provider scoped 生命周期、current/retired key 轮换、正确/错误/缺失 key、同 key nonce 重复、跨实例/跨行密文
置换、keyId/material alias/rebind、createdAt/expiresAt 篡改、身份不符、非 canonical base64url、错误 key/nonce/tag
长度与短 tag、到期、plaintext/ciphertext 帽边界、未来压缩版本的 decoded-size 防护和写入不可用路径。任何失败均
不回退到明文，raw key handle 不可导出；调试输出脱敏且不发送到群聊。

### YK-032 匿名盲测数据集

前置：YK-021、YK-031。

交付：建立匿名化群聊切片导出和人类/Yokai 盲测记录格式，不实现角色外内容检测器。

验收：导出不包含账号标识、adapter/model 信息或密钥；评价者只看到匿名消息和上下文；同一输出可由人工盲测比较来源识别率、消息长度/节奏差异和角色外泄漏率；仓库不存在运行时或离线角色外内容检测器。

### YK-033 LLM adapter 零修改兼容门禁

前置：YK-003、YK-011、YK-021。

交付：在仓库工作区之外构造并安装一个确定性的 Koishi LLM adapter 测试包。该包只依赖
`yokai-protocol`、协议锁定的精确 Effect 版本、Koishi 和自己的模拟供应商客户端，通过公开 `ctx.yokai.registerAdapter`
注册；兼容测试不得向主体或任何既有包加入该 adapter 的导入、ID、配置或分支。

验收：

- 测试 adapter 只有自己的插件包是新增实现；`protocol/core/mind/memory`、主插件、Gemini adapter
  和其他既有包的源码与包清单均无修改。
- 安装并启用后，adapter 自动发布模型快照，模型实时出现在主插件 `model` 选项中且可被选择。
- 同一 adapter 分别通过 single-pass 和 bounded-feedback 端到端用例；后者只 continue 一次。
- 声明未实现 FeedbackTool 传输契约的测试 adapter 在主插件开启能力后仍不接收 FeedbackTool，但能完成 single-pass。
- 卸载后其模型从新目录快照移除，已选值作为禁用项保留，其他 adapter 和本地存档继续工作。
- 门禁扫描主体产物与源码，不得出现测试 adapter ID、供应商 SDK、厂商枚举或静态 adapter allowlist。
- 未来每个正式 LLM adapter 都必须先通过 YK-003 契约测试和本门禁，才能标记为兼容当前协议主版本。

### YK-034 Console 独立发布与可选性门禁

前置：YK-030B、YK-031、YK-033。

交付：把 `plugins/yokai-console` 作为独立 tarball 构建、安装和发布，并建立“主体无 Console”与“Console 动态
装卸”矩阵门禁。门禁不得通过 workspace hoist、根 devDependency 或测试预加载让主体间接看到 Console package、
`ctx.console`、前端资源或持久化实现。

验收：

- 在仓库外临时 Koishi 项目只安装 database、`koishi-plugin-yokai` 与测试 adapter，node_modules 中不存在
  `koishi-plugin-yokai-console`；fresh/restart 均完成各功能自有模型初始化，并通过存档、直接/社会触发、内置 Tool、
  bounded-feedback、预算和 headless Replay 写入/清理用例。
- 单独扫描主体的 package manifest、lock dependency closure、构建产物和 npm tarball，不包含 Console 包名、
  `@koishijs/plugin-console`、`@koishijs/client`、Vue、Console route ID 或静态资源；Console tarball 则不包含
  `@yokai-internal/*` 或主体数据库实现。
- 运行中安装 Console 后修改 grant/顺序、预算和 host-managed preset，再热卸载并重启主体；policy revision、active
  preset、grant、minute/day pending/committed、审计、Replay/key meta 全部不变且角色继续生成。再次安装只 hydrate
  当前状态，缺席期间累积的 pending-review 可见，旧浏览器 expected revision 写入仍 CAS 失败。
- Console 在写请求中卸载时取消所属请求 Scope；事务只能全成或全不成，主体回合、reservation 和 managed preset
  source 不受影响。重复装卸不泄漏路由、订阅、监听器或前端资源。
- 缺少 `yokai`/`console` service、control protocol major 不兼容、feature 缺失、Console 启动失败或浏览器断线时只
  使 Console fail-local/unavailable；主体继续存档、门控、生成和预算计费，且不会因 Console 重连重复 bootstrap、
  refresh model 或创建 policy revision。

## 7. 推荐交付批次

| 批次 | 任务                    | 可演示结果                                                                |
| ---- | ----------------------- | ------------------------------------------------------------------------- |
| A    | YK-001～YK-005          | 每个 Gemini adapter 实例通过单逻辑连接的有序 URL/key 端点发布一份模型目录 |
| B    | YK-006～YK-008          | Gemini adapter 通过文本、函数调用、单次反馈、用量和容错契约               |
| C    | YK-009～YK-012          | 主插件配置实时展示 adapter 模型，@ 当前机器人后使用选中模型回复           |
| D    | YK-013～YK-021          | 存档、门控、上下文、双 Tool 协议和有界反馈管线完整运行                    |
| E    | YK-022～YK-028          | 话题、状态、关系、记事本、讨论租约、定时与主动行为逐项可用                |
| F    | YK-030A、YK-031～YK-033 | 无 Console 的主体可治理、可回放、可盲测且能零修改接入新 adapter           |
| G    | YK-030B、YK-034         | 独立可选 Console 提供精细管理，装卸不改变主体运行与持久状态               |

Gemini `models.list` 的分页、`supportedGenerationMethods` 和 token 上限字段以
[Gemini Developer API 官方模型参考](https://ai.google.dev/api/models)为验收基准，不在代码中维护固定模型名单。
