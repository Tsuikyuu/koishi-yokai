# Yokai LLM Adapter 协议

状态：YK-002 Draft 0.1

协议版本：`0.1`

实现包：`@yokai/protocol`

## 1. 目标

该协议只抽象 Yokai 主体当前需要的三项能力：动态发现文本模型、完成一次文本生成，以及在首次生成返回 FeedbackTool 调用时完成唯一一次续接。

它不是通用 LLM SDK，也不是 Agent 运行时。协议刻意不包含：

- 任意 `providerOptions`、厂商枚举、SDK 类型、HTTP 请求或响应对象；
- 流式事件、多模态内容、结构化 JSON 输出、内建工具执行器；
- 主体级自动重试、模型 fallback、跨 adapter/跨模型凭据轮转或开放式工具循环；
- Koishi `Context`、`Session`、`Disposable` 或配置类型。

厂商认证、客户端、连接池、采样细节和 wire format 全部留在 adapter 插件内部。adapter 可以在一次
逻辑调用内对同一模型执行私有、有界的等价端点尝试；端点配置、选择和物理尝试次数不进入协议，
也不能借此改变模型或增加主体生成步骤。主体只依赖本协议。

## 2. Adapter 形状

`YokaiAdapter` 是可以动态注册的普通只读值，不是全局 `Context.Service`。同一进程可以同时存在不同 adapter；每个插件可在自己的 Effect Layer 中构造实例，再交给主体注册表持有。

```ts
interface YokaiAdapter {
  readonly descriptor: AdapterDescriptor
  readonly discoverModels: () => Effect<AdapterModelSnapshot, AdapterInvocationError>
  readonly generate: (
    request: GenerateRequest,
  ) => Effect<FinalTextResult | ToolCallBatch, AdapterInvocationError, Scope>
  readonly continue: (request: ContinueRequest) => Effect<FinalTextResult, AdapterInvocationError>
}
```

`generate` 获取角色回合的 Effect `Scope`。adapter 必须把新 continuation 绑定到这个 owning Scope，并在它关闭时立即使 handle 失效；`continue` 使用 handle 找回该生命周期，不比较当前调用所在子 Scope 的对象 identity。调用方取消通过 Effect interruption 传播；adapter 在 SDK 边界把 interruption 转成厂商 `AbortSignal`，不能在公共请求中暴露原生 `AbortSignal`。

具体厂商实现可以有自己的本地 `Context.Service` tag，但不得把厂商服务需求泄漏到上述方法的 Effect 环境中。

## 3. 身份、引用和版本

### 3.1 身份

- `AdapterId` 使用 `[A-Za-z][A-Za-z0-9._-]*`，最长 128 个 UTF-16 code units。
- `AdapterModelId` 是最长 512 个 code units 的非空、首尾无空白 opaque string，允许包含任意 `/`，但不允许 Unicode `Other`（C）类别字符；主体不解析或归一化。
- `ModelReference` 的编码固定为 `<adapterId>/<modelId>`。解码只查找第一个 `/`；例如 `gemini/models/flash` 解码为 adapter `gemini` 和 model `models/flash`。
- `FeedbackToolId` 使用可跨供应商传输的 `[A-Za-z_][A-Za-z0-9._-]*`，最长 128；这保留 `history.search` 和 `<server>.<tool>` 命名。
- `ToolCallId` 是最长 256、首尾无空白且不含 Unicode C 类字符的非空 opaque string。供应商未给 ID 时，adapter 在当前 continuation 内生成稳定 ID。

### 3.2 版本

`AdapterProtocolVersion` 显式包含非负安全整数 `major/minor`。当前版本为实验性的 `0.1`：先由 Gemini 文本和 bounded-feedback 路径验证，再决定是否提升为稳定 major 1。

兼容规则只比较 major。同 major 的 minor 只能增加可缺省、可忽略的信息；旧端解码后丢弃未知字段，不能把它们透传给 provider。新增结果变体、必填字段，或改变 continuation/调用次数/生命周期语义都必须提升 major。未知 `_tag` 始终拒绝。

所有可由 minor 增加的 DTO 字段在内存 Type 和编码形状中都使用真正的 optional property，而不是必需的 `Option` 字段。因而旧实现缺少新字段时，新端读取到 `undefined`；新实现收到旧请求时也必须按字段缺省处理。这个约束与“只增加 optional 字段”共同保证同 major minor 的双向运行时兼容。

`AdapterDescriptor` 固定 adapter ID、协议版本和 `capabilities.feedbackTools`。该布尔值只表示 adapter 实现了协议定义的 FeedbackTool 传输，不证明某个模型支持函数调用，也不能据此执行逐模型探测。

主体在保存或调用 adapter 前必须执行 `negotiateAdapterProtocol`。不兼容 major 返回 `AdapterProtocolVersionMismatchError`，并保证 `discoverModels/generate/continue` 的调用数均为零；同 major 的新旧 minor 均可通过握手。

## 4. 模型发现

`discoverModels()` 返回一次成功的 `AdapterModelSnapshot`：

- `discoveredAt`：UTC 时间；
- `models`：按 adapter-local model ID 的 UTF-16 code-unit 顺序严格递增，ID 唯一；
- 每个模型包含 `id/displayName/availability/discoveryFreshness`。模型在本次成功列举中出现即为 `fresh`；多来源 adapter 可为刷新失败的来源保留 last-good 描述并标记 `stale`；
- 通过 adapter 自身静态资格过滤并出现在成功清单中的模型记为 `available`；只有供应商明确返回不可用状态时才记为 `unavailable`，不能为填写该字段主动探测模型；
- `inputTokenLimit/outputTokenLimit` 只在供应商明确返回时出现，且必须是正安全整数；
- `displayName` 最长 256；`supportedGenerationMethods` 是供应商明确返回、名称最长 128、去重并稳定排序的 opaque metadata，缺失时保持缺失，主体不得把它解释为通用能力。

adapter 快照不带全局 revision 或 adapter 级 discovering/offline/failed 状态。主体判断“目录内容是否变化”时比较模型内容（包括 freshness），明确排除每次刷新都会变化的 `discoveredAt`；全局目录版本和 adapter 状态合并属于主体注册表任务。

## 5. 首次生成

`GenerateRequest` 只包含：

- adapter-local `modelId`；
- 可缺省的非空 system instruction；
- 至少一条 `user/assistant` 文本消息；
- `limits: { maxOutputTokens }`，其中输出预算是正安全整数；
- 当前回合选中的零个或多个 `FeedbackToolDeclaration`。

FeedbackTool description 最长 2048。同一请求中的 FeedbackTool ID 必须唯一；重复声明在进入 adapter/provider 前失败。

协议不提供 temperature、top-p、top-k、seed、headers 或 `providerOptions`。这些值不是当前主体需要跨厂商控制的行为。

`generate` 只能返回两个互斥变体：

1. `FinalTextResult`：非空最终文本、统一停止原因和本次逻辑生成成功响应的 usage；空 candidate 或不含安全可用文本的拦截必须转换为类型化 adapter 错误；
2. `ToolCallBatch`：一批有序、非空且 call ID 唯一的通用调用、一次 usage 和一个 opaque continuation。

供应商在工具调用旁返回的临时文本不进入 `ToolCallBatch`，主体不能把它作为 XML 发送或执行。完整原始部件只保存在 adapter 的 continuation state 中。

## 6. FeedbackTool portable Schema

`FeedbackToolDeclaration` 只向 adapter 公开稳定 ID、用途描述和 `PortableToolInputSchema`。它不包含执行函数、输出 Schema、超时或宿主权限；这些仍由主体冻结的 FeedbackTool 注册项持有。

portable 输入根节点固定为闭合 Object，adapter 编译时必须设置 `additionalProperties: false`。允许的 AST 变体只有：

- `String`、带可选有限 `minimum/maximum` 的 `Number`、带可选安全整数边界的 `Integer`、`Boolean`；
- 非空且值唯一的 `StringEnum`；
- 显式 `minItems/maxItems` 的 `Array`；
- 名称唯一、逐字段声明 `required` 的 `Object`。

禁止 `null`、任意 union、`oneOf/anyOf/allOf`、`$ref`、transform、自定义 refinement 和厂商 keyword。协议固定以下防御性上限：

| 约束                        | 上限 |
| --------------------------- | ---: |
| 嵌套深度（根 Object 计 1）  |    5 |
| 整棵树 Object property 总数 |  100 |
| 单个 Array 的 `maxItems`    |  128 |
| StringEnum 值数量           |   64 |
| 单个 StringEnum 值长度      |  256 |
| Object property 名称长度    |  128 |
| 任一 AST 节点 description   | 1024 |

解码器本身由固定五层的非递归 codec 组成，不存在“先递归完整解码、再检查深度”的栈溢出路径；属性计数再用迭代算法验证。这些常量属于协议语义；破坏已有合法声明需要提升 major。

## 7. Tool 调用、结果和唯一续接

`ToolCall` 只包含 `callId/toolId/input`，其中 input 必须是 JSON object。主体在执行任何调用前原子验证整批 ID、工具可见性和输入；非法批次执行数为零。

`ToolResultBatch` 本身是非空数组，call ID 唯一，因而 `ContinueRequest.results` 不会形成 `results.results` 双层包装。结果是：

- `Success`：任意 JSON output；
- `Failure`：稳定 reason，以及可缺省、最长 1024 的已脱敏安全消息。

adapter 必须无损保留 Success 的 JSON 值。若供应商 wire format 只接受 object，统一编码为 `{ "ok": true, "value": <output> }`；Failure 编码为 `{ "ok": false, "reason": <reason>, "message"?: <safe message> }`。这样 `null`、scalar、array 和 object 不需要厂商 adapter 各自发明包装规则。

结果数组允许与调用数组顺序不同。adapter 必须按 call ID 验证结果集合与 pending 调用集合完全相等，再按首次供应商调用顺序恢复 wire response；不得按工具名或数组位置猜测关联。

`ContinueRequest` 只有 continuation 和 `ToolResultBatch`，没有 model、消息、新提示或工具定义。adapter 从 continuation state 恢复原 adapter、model、turn 和完整供应商历史。

continuation 的状态机固定为：

```text
pending --原子 claim--> claimed --成功/失败/超时/取消--> removed
    └-- Scope 或 adapter 关闭 -----------------------> removed
```

claim 必须发生在 `continue` 的最终逻辑生成进入首个供应商端点之前；一旦 claim，无论结果如何都不能恢复。
重复、并发、跨 adapter 或过期消费都在供应商调用前统一返回
`AdapterContinuationError(reason = "invalid")`，不通过细粒度原因泄漏 handle 状态，也不要求 adapter
维护 tombstone。两个并发 `continue` 最多一个可以进入供应商边界。

`continue` 只表示一次同模型逻辑生成，返回类型只能是 `FinalTextResult`。adapter 可以在这次调用内按
私有策略有界尝试等价端点，但不得改变模型或把端点尝试暴露为新的生成步骤。供应商再次请求 Tool 时返回
`AdapterProtocolViolationError`，协议不提供第三次逻辑生成入口。

## 8. Continuation 的不透明与不可持久化

`AdapterContinuation` 使用 Effect `Redacted` 包装随机、短生命周期的内存 lookup key。handle 本身不得包含 provider response ID、消息历史、thought signature、凭据或模型 ID；这些值只存在 adapter 作用域内的状态表中。

lookup key 最长 256；它只是 adapter 状态表的随机键，不是供应商 response ID。

- 普通字符串化、inspect 和 JSON stringify 不显示 key；
- Effect 内存 Schema 可以验证并往返 `Redacted` 值；
- canonical JSON codec 明确禁止编码，因此它不能进入配置、快照或持久化历史；
- 日志、错误和 metrics 不得包含 handle。

这一区分解决了“跨包传回原 adapter”与“不可持久化”两个要求，并避免把 Effect AI 的 `previousResponseId` 误当作完整 continuation。

公共 `makeAdapterContinuation` 是返回 `Effect` 的安全构造器；空值、超长值等以 `SchemaError` 失败，不通过 `.make` 同步抛异常。

## 9. Usage 和停止原因

usage 表示当前一次逻辑生成中成功供应商响应报告的增量，不聚合失败或超时的端点尝试；这些尝试可能
已经产生但无法取得用量。`continue` 不得累计首次生成的 usage，主体负责把 bounded-feedback 的两次
成功响应 usage 聚合。

`GenerationUsage` 是：

- `Unavailable`；或
- `Reported`，至少包含一个已知计数：input、output、total、cached input、reasoning output。

每个已知值都是 `0..Number.MAX_SAFE_INTEGER` 的整数。未知值保持缺失，不能伪造为零；协议不强制 `total = input + output`，因为跨供应商的缓存和推理统计语义不同。

最终文本停止原因固定为 `stop/length/content-filter/other/unknown`：`other` 表示供应商明确返回了可映射为 OTHER 的原因，`unknown` 表示原因缺失或 adapter 无法识别。工具暂停由 `ToolCallBatch` 变体表达，错误进入 Effect error channel，不用 finish reason 推测结果种类。

## 10. 错误

方法错误使用不含注册期状态的封闭 `AdapterInvocationError` union；`AdapterError` 是供跨注册/调用边界统一记录时使用的超集：

- configuration、authentication、rate-limit、timeout；
- provider-reported cancelled、transport、provider-response、protocol-decode；
- unknown SDK rejection 对应 internal；unsupported、continuation、protocol-violation；
- 注册握手失败对应 protocol-version-mismatch。

调用期错误的 operation 只能是 `discoverModels/generate/continue`，并只包含 adapter/model 等安全上下文、稳定 reason、可选状态码或 retry-after，以及从稳定 tag/reason 和安全字段构造、最长 1024 的短消息；`register` 只用于 version mismatch，后者只记录 adapter ID 和 supported/candidate versions。continuation error 的 operation 固定为 `continue`、message 固定为 `Invalid adapter continuation`，不能泄漏 handle 状态。其他错误也不得直接复制 SDK message，且不得包含 SDK error、cause、stack、headers、raw body、key、完整提示、回复或 continuation。真正违反代码不变量的情况保留为 Effect defect，不伪装成 adapter error。

Effect caller interruption必须保持 interruption，不能被捕获成普通 typed cancelled error；`AdapterCancelledError` 只表达 SDK 或供应商主动报告的取消。

## 11. YK-002 与 YK-003 边界

YK-002 必须拥有 `AdapterModelSnapshot` 的公共 Schema，否则 `discoverModels()` 无法形成完整接口。YK-003 不再重新定义该类型，只交付：

- 所有 adapter 复用的 conformance suite；
- 确定性 fake adapter；
- 逻辑生成次数、取消、快照不可变、continuation 绑定/竞争/失效、结果集合和错误归一化通用测试，
  以及由各 adapter 专属测试验证的同模型物理尝试上界。

Gemini adapter 必须在 YK-008 结束前通过该完整套件。

## 12. 开源经验取舍

- [Effect AI](https://github.com/Effect-TS/effect/tree/66114151c2b4640bf773f2b3456ce70d679422f6/packages/effect/src/unstable/ai)：借鉴 Effect service、Schema、tagged response/error 和 provider hook 分层；不公开 `effect/unstable/ai` 类型，也不采用自动 Tool handler、stream 或 `previousResponseId` 作为协议。
- [Vercel AI SDK Provider v4](https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v4)：借鉴显式 spec version、判别结果、call ID、usage 和 provider 独立包；拒绝 `providerOptions`、raw metadata、多模态和开放式多步调用。
- [PydanticAI deferred tools](https://github.com/pydantic/pydantic-ai/blob/main/docs/deferred-tools.md)：借鉴按 call ID 暂停和恢复、结果集合验证；拒绝完整消息历史重放、审批、partial resolution 和 durable Agent loop。
- [LangChain standard tests](https://github.com/langchain-ai/langchainjs/tree/main/internal/standard-tests)：借鉴一个 conformance suite 验证所有 provider；不引入 Runnable、callback 或 Agent 抽象。
- [ChatLuna](https://github.com/ChatLunaLab/chatluna)：只借鉴 Koishi 注册、disposer、动态刷新和 adapter 包拆分；不复制其 Koishi/LangChain 类型耦合、能力猜测、可变模型池或多步 Agent。其 AGPL 代码不进入 Yokai 实现。
