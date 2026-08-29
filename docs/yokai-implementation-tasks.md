# Yokai 可验收实施任务

状态：Draft 0.8

依据：[`yokai-design.md`](./yokai-design.md)

首发 adapter：`koishi-plugin-yokai-adapter-gemini`

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
- Gemini adapter 将官方 `@google/genai` 锁定为稳定 2.x 精确版本，并声明 `node >= 20` 运行时基线；其他工作区不引入该 SDK。当前精确版本尚无实例级 fetch 注入口时，Gemini adapter 工作区允许把本地 Yarn patch 作为已接受的开发期偏差并保持 `private: true`；正式发布门禁延后，发布前仍必须改用包含该注入口的上游精确版本或已发布、可审计的 scoped fork/npm alias。
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
- 当前官方精确版本没有实例级 fetch 注入口时，本地 Yarn patch 是已接受的开发期偏差，Gemini adapter 包必须
  保持 `private: true`，且该偏差不阻塞后续内部任务；正式发布门禁延后，发布前仍须切换到包含该最小注入口的
  上游精确版本或已发布、可审计的 scoped fork/npm alias，不能要求使用者复现仓库根级 Yarn patch。
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

交付：先不引入活跃度、记忆和工具，定义只含 `reply/silence` 与 message 的最小 XML 信封，使用 YK-003 的 fake adapter 完成“Koishi 收到 @ → 冻结少量消息 → 通用 adapter 生成 XML → 严格解析 → 发送一条角色消息”的供应商无关最小纵切。后续 YK-020 在此解析器上扩展完整 decision、directive 和 ActionTool。

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

验收：同 `scopeId + mergeKey` 爆发只创建一回合；@/回复使用独立短 debounce，绕过活跃度并合并补充消息；社会触发使用较长消息簇窗口且必须同时过阈值、冷却和预算；冷路径模型请求数为 `0`。

### YK-019 版本化人格预设热更新

前置：YK-009。

交付：实现 Persona Schema、文件 preset source、debounce、编译/hash 和原子快照替换。

验收：合法修改只影响下一回合；畸形文件保留最后有效版；相同 hash 不重复发布；更新不清理关系、记忆、租约或定时任务。

### YK-020 角色 XML 协议、ActionTool 模板与提示

前置：YK-009、YK-012、YK-019。

交付：扩展 YK-012 的版本化 `<yokai-response>` XML 信封，加入 `silence/react/reply/follow-up/initiate` decision、唯一 message、ActionTool 和 directive，编译严格角色内提示及当前可见 ActionTool 的精确 XML 模板，并实现安全解析和 Schema 解码。代码级协议见 [`yokai-role-response-protocol.md`](./yokai-role-response-protocol.md)。

验收：

- 所有 decision 穷尽解码；reply 必须有合法 message，silence 不得携带待发文本。
- 禁用 DTD、外部实体和网络访问，并限制 XML 字节数、深度、文本长度及动作数量。
- 未知/重复元素、未知 ActionTool、额外参数、越权作用域、畸形转义和 Schema 失败均不能进入执行器。
- 整体 XML 畸形时不猜测或降级提取消息，不向群聊发送 XML 片段。
- ActionTool ID、执行阶段、完成/失败策略来自能力快照，模型只能填写模板参数。
- 提示包含角色外禁语、不可信上下文边界，以及“异步动作完成前不得声称成功”；当前、focus、群聊和用户消息均视为不可信数据，focus 以包含 `messageId`、`authorId`、`timestamp`、`content` 的带标签 JSON block 注入，其 ID 必须可用于本回合 `reply-to` 白名单。
- 不增加角色外内容检测、二次 LLM 审查或重写步骤。

### YK-021 有界回合编排、动作执行与失败沉默

前置：YK-003、YK-011、YK-014、YK-018、YK-020。

交付：运行有界 ContextProvider 并组装单一冻结上下文，选择一个可用模型，执行首次生成；文本结果进入 XML 快速路径，ToolCallBatch 则执行一批 FeedbackTool 并进行唯一最终生成；最后校验角色 XML，按注册策略执行 `before-send/after-send/deferred` ActionTool，并按长度和场景计算发送节奏。生成期间不因新消息或话题变化取消、重做或复核当前回合。

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
- 决策为 silence 时不发送；adapter、Tool、XML、超时和限流错误都不进入群聊。
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

交付：在 @/回复后建立有界 `EngagementLease`，支持延长/关闭 directive 和 engagement 提案。

验收：只有租约参与者可继续触发；多段消息仍合并；TTL、最大轮数、转话题和显式关闭均可结束租约；过期后恢复普通门控。

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

交付：仅从未完话题、高相关近期内容和允许的固定群活动生成 initiative 提案。

验收：默认不主动私聊；无具体社会动机不提案；频道冷却、关系阈值和 background 预算任一不满足时不创建回合。

## 6. 控制面与评测

### YK-029 数据库迁移与管理命令

前置：YK-013、YK-017、YK-019、YK-023、YK-024、YK-026。

交付：汇总并验证前置任务逐项引入的最小表集与版本迁移，增加有权限的查询和停用命令，并确保管理输出不经过角色管线。

验收：空库可升级，重复迁移幂等；普通群成员无法调用管理命令；技术错误只出现在控制面；除 YK-013 的保留期清理外，不提供撤回同步、消息级删除或手动删除入口。

### YK-030 Console 控制面

前置：YK-011、YK-019、YK-029。

交付：提供 Koishi Console 页面与后端服务，管理预设和频道停用，并展示 adapter/连接状态、最近发现时间、发现的模型及手动刷新操作。模型选择与 `feedbackToolsEnabled` 继续使用主插件原生配置表单，此页不维护第二份选择状态。

验收：

- 状态页与主插件配置表单读取同一模型目录快照，不存在前端固定列表或独立选中值。
- 用户可查看上次成功/失败状态并手动刷新；刷新不阻塞普通消息存档。
- 已配置但当前不可用的模型显示明确警告，不自动改写配置。
- 页面、RPC 和浏览器日志均不返回 API key、完整群聊或完整模型提示。

### YK-031 调试指标与成本回放

前置：YK-018、YK-021、YK-029。

交付：分别记录活跃度分布、触发原因、合并数、逻辑生成数和供应商物理 endpoint 尝试数，以及
single-pass/bounded-feedback 路径、FeedbackTool 批次与结果 token、ContextProvider 查询、XML 解析、
ActionTool 阶段、费用、模型耗时、编排耗时和人为等待，提供离线回放。

验收：同一录制输入在固定 Clock/随机服务下得到同一门控结果；可断言 single-pass 逻辑生成数为 1、
bounded-feedback 为 2 且无第三次逻辑生成，同时单独观察每次逻辑生成的 endpoint 尝试数与超时后重复计费
风险；汇总单次路径比例、反馈工具率、XML 有效率、唤醒到请求发出 p95、XML 编排 p95、模型耗时、
人为等待、每 100 条消息回合数和每千条成本；调试输出脱敏且不发送到群聊。

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

## 7. 推荐交付批次

| 批次 | 任务           | 可演示结果                                                                |
| ---- | -------------- | ------------------------------------------------------------------------- |
| A    | YK-001～YK-005 | 每个 Gemini adapter 实例通过单逻辑连接的有序 URL/key 端点发布一份模型目录 |
| B    | YK-006～YK-008 | Gemini adapter 通过文本、函数调用、单次反馈、用量和容错契约               |
| C    | YK-009～YK-012 | 主插件配置实时展示 adapter 模型，@ Yokai 后使用选中模型回复               |
| D    | YK-013～YK-021 | 存档、门控、上下文、双 Tool 协议和有界反馈管线完整运行                    |
| E    | YK-022～YK-028 | 话题、状态、关系、记事本、讨论租约、定时与主动行为逐项可用                |
| F    | YK-029～YK-033 | 可运维、可回放、可盲测且能零修改接入新 adapter 的 MVP                     |

Gemini `models.list` 的分页、`supportedGenerationMethods` 和 token 上限字段以
[Gemini Developer API 官方模型参考](https://ai.google.dev/api/models)为验收基准，不在代码中维护固定模型名单。
