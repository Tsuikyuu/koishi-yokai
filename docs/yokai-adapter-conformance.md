# Yokai adapter conformance 设计

实现包：`yokai-adapter-conformance`

协议依据：[`yokai-llm-adapter-protocol.md`](./yokai-llm-adapter-protocol.md)

## 1. 目标与边界

`yokai-adapter-conformance` 为所有 `YokaiAdapter` 提供同一套供应商无关的测试输入、可观测控制面、Vitest 契约套件和确定性 fake adapter。它解决两类仅靠 `YokaiAdapter` 公共返回值无法验证的问题：

- 每个 `generate/continue` 是否只形成一次同模型逻辑生成、物理端点尝试是否有界、取消是否到达
  供应商边界、是否发生了隐藏的能力探测；
- continuation 是否恢复原 model、首次调用顺序和 owning Scope，并在并发、失败和作用域关闭时正确失效。

本包只使用 `yokai-protocol` 的通用 DTO 和 Effect 生命周期，不定义新 adapter 协议，也不包含 Koishi、Gemini 或其他供应商 SDK 类型。真实 adapter 通过一个测试专用 factory，把通用脚本翻译为自己的 SDK 或 HTTP stub 行为，再复用同一套断言。

## 2. 包入口

包刻意拆成三个导入图：

| 入口                               | 内容                                                         | 运行时依赖 Vitest |
| ---------------------------------- | ------------------------------------------------------------ | ----------------- |
| `yokai-adapter-conformance`        | factory、setup、control、event 和模型快照内容等价 helper     | 否                |
| `yokai-adapter-conformance/fake`   | `makeFakeAdapter`、fake options、fake subject 和额外 control | 否                |
| `yokai-adapter-conformance/vitest` | 显式注册通用测试的 `defineAdapterConformanceSuite`           | 是                |

根入口只转出 `conformance` 公共面，不隐式转出 fake 或 Vitest。主体集成测试可以只依赖 `/fake`，真实 adapter 的契约测试同时依赖根入口和 `/vitest`。

`./vitest` 是仅 ESM `import` 的子路径。`vitest` 与 `@effect/vitest` 只作为可选 peer dependency 和本包自身的 dev dependency 存在；根入口和 `/fake` 的生产导入图不会静态导入它们。仅导入 `/vitest` 也不会自动注册测试，调用方必须显式调用 `defineAdapterConformanceSuite`。

## 3. 通用 factory 契约

### 3.1 Factory 与 Subject

真实 adapter 和 fake 都通过以下测试边界交给套件：

```ts
interface AdapterConformanceFactory {
  readonly make: (
    setup: AdapterConformanceSetup,
  ) => Effect.Effect<AdapterConformanceSubject, never, Scope.Scope>
}

interface AdapterConformanceSubject {
  readonly adapter: YokaiAdapter
  readonly control: AdapterConformanceControl
}
```

`make` 是有作用域的资源获取。factory 应在该 Scope 内构造 provider stub、客户端、请求 fiber 和其他测试资源；Scope 关闭后，进行中的请求必须被中断，subject 不再持有可用的 provider 生命周期。

factory 是 adapter 专属的翻译层。它可以在闭包中持有连接配置或 SDK stub，但返回给通用套件的只有 `YokaiAdapter` 和统一 control，不能把供应商对象加入 setup、event 或公共 subject。

setup、原始模型、原始 ToolCall、失败分类和 event 都同时导出运行时 Schema；来自 JSON 或普通测试夹具的值应先解码，再交给 factory。它们是测试协议，不会加入 `yokai-protocol` 的生产 DTO。

### 3.2 Setup 脚本

`AdapterConformanceSetup` 包含两个按顺序消费的只读脚本：

```ts
interface AdapterConformanceSetup {
  readonly discoverySteps: ReadonlyArray<AdapterDiscoveryStep>
  readonly generationSteps: ReadonlyArray<AdapterGenerationStep>
}
```

`discoverySteps` 的变体为：

- `Success`：携带原始 `discoveredAt`、原始模型数组和 `blocked`；
- `Failure`：携带通用失败注入和 `blocked`。

原始模型数组故意允许乱序和重复 ID；`supportedGenerationMethods` 也故意允许乱序和重复值。adapter 必须生成通过 `AdapterModelSnapshot` Schema 的唯一、稳定排序结果。供应商未给出的 token limit 或 generation methods 必须继续缺失，不能由 factory 或 adapter 补默认值。

`generationSteps` 同时供 `generate` 和 `continue` 按物理请求顺序消费，其变体为：

- `Text`：携带 `FinalTextResult` 和 `blocked`；
- `ToolCalls`：携带未做批次校验的原始调用数组、单次 usage 和 `blocked`；
- `Failure`：携带通用失败注入和 `blocked`。

原始 ToolCall 数组可以为空、包含重复 call ID 或调用未声明工具，以便测试 adapter 在供应商边界后的协议校验。
无故障转移时，bounded-feedback 的典型脚本是首个 `ToolCalls` step 紧接一个 `Text` step；专属测试可以在
每个逻辑阶段插入失败端点 step，但禁止第三个逻辑生成阶段。

通用套件的 factory 对支持多 endpoint 的 adapter 使用单 endpoint 配置，使标准错误映射用例的一个
failure step 不会被私有故障转移吞掉；成功用例同样为每次逻辑生成提供一个立即成功的物理 step。
具有等价 endpoint 的 adapter 可以在自己的专属 setup 中为同一 model 编排多个失败/成功 step；这些 step
仍属于一次 `generate` 或 `continue` 逻辑调用，必须受专属测试中已配置的端点数上界约束。

`AdapterConformanceFailure` 使用以下供应商无关分类：

- `configuration`、`authentication`、`rate-limit`、`timeout`；
- `provider-cancelled`、`transport`、`provider-response`、`protocol-decode`；
- `internal`、`unsupported`。

其中 `providerMessage` 是明确不可信的 canary，adapter 不得把它复制到公开错误、日志或快照。`retryAfterMs` 和 `statusCode` 只在对应分类中作为可选、已验证的安全字段使用。

每个 step 的 `blocked` 决定该物理请求是否在发布 `RequestStarted` 后暂停。脚本数组允许为空；当实现发起了未被脚本授权的额外请求时，测试 harness 应以 defect 暴露脚本耗尽，而不是静默重复最后一步。

## 4. Control 与事件

### 4.1 统一 control

```ts
interface AdapterConformanceControl {
  readonly takeEvent: () => Effect.Effect<AdapterTestEvent>
  readonly events: () => Effect.Effect<ReadonlyArray<AdapterTestEvent>>
  readonly release: (requestId: number) => Effect.Effect<boolean>
  readonly activeRequests: () => Effect.Effect<number>
}
```

- `takeEvent()` 从事件队列取下一项，用于无真实 sleep 的确定性并发同步；
- `events()` 返回截至当前的不可变事件历史，用于最终计数和顺序断言；
- `release(requestId)` 释放一个被 `blocked` gate 暂停的请求；首次有效释放返回 `true`，未知、已结束或已释放的 ID 返回 `false`；
- `activeRequests()` 返回已经进入 provider 边界但尚未产生 terminal event 的请求数。

control 是测试观察能力，不进入 `YokaiAdapter`，主体运行时也不得依赖它。

### 4.2 事件模型

每个实际进入 provider harness 的请求先产生一个 `RequestStarted`：

- `requestId`：当前 subject 内单调分配的正整数，只用于关联测试事件；
- `kind`：`model-list`、`generation` 或 `capability-probe`；
- `operation`：`discoverModels`、`generate` 或 `continue`；
- `modelId`：发现请求缺失，生成与续接请求携带实际使用的 adapter-local model ID；
- `resultCallIds`：`continue` 记录按首次 ToolCall 顺序恢复后的结果 ID，其他请求为空数组。

请求随后恰好产生一个只携带相同 `requestId` 的 terminal event：

- `RequestSucceeded`：供应商边界成功；
- `RequestFailed`：供应商边界以类型化错误失败；
- `RequestCancelled`：请求 Effect 被中断。

通用套件通过 `kind = capability-probe` 观察隐藏探测，并要求普通模型发现和生成场景的该类事件数为零。invalid continuation、结果集合不匹配、未启用 FeedbackTool 等 provider 前失败不产生 `RequestStarted`。

`requestId` 只是单个测试 subject 的临时事件 ID，不是模型目录 revision、adapter revision 或持久化请求标识。

## 5. 确定性 fake adapter

### 5.1 构造与注册形态

`makeFakeAdapter(options, setup)` 返回有作用域的 `FakeAdapterSubject`。options 为：

```ts
interface FakeAdapterFactoryOptions {
  readonly adapterId: AdapterId
  readonly feedbackTools: boolean
  readonly tokenNamespace: string
}
```

fake descriptor 使用当前 adapter 协议版本，并把 `feedbackTools` 原样声明为 adapter 级传输契约。测试应分别构造 `true` 和 `false` 两种 subject；`false` 形态仍支持无工具的 single-pass 请求，非空 FeedbackTool 声明则在 provider 前返回 `AdapterUnsupportedError`。

`tokenNamespace` 为确定性 continuation key 增加测试命名空间；每个 fake subject 仍持有彼此隔离的私有状态表。调用方应保持该值短且稳定；若同一 adapter ID 的多个 fake 同时创建 handle，可为不同 factory 配置不同命名空间。测试不能读取或依赖最终 handle 的内部文本。

fake control 在统一 control 之外增加：

```ts
interface FakeAdapterControl extends AdapterConformanceControl {
  readonly pendingContinuations: () => Effect.Effect<number>
}
```

该值统计尚未从内部 continuation 状态表清理的 entry，包括正在执行唯一续接的 claimed entry；它只用于 fake 白盒泄漏检查。

如需把 fake 交给通用套件，可在测试文件中固定 options：

```ts
const factory: AdapterConformanceFactory = {
  make: (setup) => makeFakeAdapter(options, setup),
}

defineAdapterConformanceSuite('provider-neutral fake', factory)
```

主体集成测试则应只把 `subject.adapter` 当作 `YokaiAdapter` 使用，不读取 fake control，也不根据 fake adapter ID 编写分支。

### 5.2 模型发现与错误

fake 的每次 `discoverModels` 消费一个 discovery step，并且只运行一次 `model-list` provider 请求。成功响应执行以下规范化：

- 同一模型 ID 保留首个原始项，再按 adapter-local ID 的 UTF-16 code-unit 顺序排序；
- generation methods 去重并稳定排序；
- freshness、availability 和供应商明确给出的元数据原样保留；
- 缺失的可选元数据继续缺失；
- 最终结果通过公共 `AdapterModelSnapshot` Schema 解码。

fake 不发起 `capability-probe`，不根据模型名称或 methods 推断通用能力，也不访问消息、人格、记忆或发送权限。

失败 step 被映射为对应 `AdapterInvocationError`。fake 使用固定安全消息，绝不复制 `providerMessage`；供应商主动报告取消映射为 `AdapterCancelledError`，而 Effect caller interruption 保持 interruption，只在 control 中表现为 `RequestCancelled`。

### 5.3 首次生成与唯一续接

fake adapter 没有等价 endpoint 配置。每次合法 `generate` 消费一个 generation step，并最多进入一次
`generation` provider 请求：

- `Text` 解码为最终文本结果；
- `ToolCalls` 先验证重复 call ID 和未声明工具，再通过公共 `ToolCalls` Schema；验证成功后才创建 continuation；
- `Failure` 返回对应类型化 adapter 错误。

fake continuation store 以每实例私有 `HashMap` 保存 `modelId`、首次有序 ToolCalls 和 owning Scope。handle 使用 Effect `Redacted`，内部由 adapter ID、`tokenNamespace` 与递增序号形成确定性 lookup key；该 key 不进入事件、错误或日志，具体编码不属于公共契约。

创建 handle 时，entry 通过 `Effect.acquireRelease` 绑定当前 `generate` 的角色回合 Scope。Scope 已关闭或随后关闭时，finalizer 删除 entry。因此把 `Effect.scoped(adapter.generate(request))` 单独运行并把 ToolCallBatch 带到作用域外，会得到一个已经失效的 handle；成功路径必须让 `generate` 和 `continue` 共享仍然打开的角色回合 Scope。

`continue` 不读取当前调用方的 Scope identity，而是从 handle 恢复原 owning Scope 和 model：

1. 在单个原子状态更新中把 `pending` claim 为 `claimed`；unknown、已 claim、已消费、跨 adapter 或已过期 handle 统一返回 invalid continuation；
2. 按 call ID 验证结果集合与首次调用集合完全相等；失败发生在 provider 前；
3. 按首次 ToolCall 顺序重排结果，并在 `RequestStarted.resultCallIds` 中公开该安全观测；
4. 只消费一个后续 generation step；由于 fake 没有等价 endpoint，唯一续接只进入一次 provider 边界；
5. 若供应商再次返回 ToolCalls，以 `unexpected-tool-call` 协议错误终止，不创建新 handle，也不发起第三次逻辑生成；
6. 无论成功、类型化失败、取消或协议失败，都删除 claimed entry，不恢复为 pending。

因此两个并发 `continue` 最多一个能进入 provider 边界；另一个在请求前得到统一 invalid continuation。原 adapter handle 交给另一个 fake 实例时不会破坏原实例的 pending entry。

### 5.4 Scope 与请求取消

fake factory 自身需要 adapter Scope。provider harness 在该 Scope 中持有一个 `FiberSet`，而生成与续接请求 fiber 还会注册到各自恢复出的 owning turn Scope。请求调用方通过 `Effect.acquireUseRelease` 等待并拥有该 provider fiber。

下列任一事件都会中断仍在运行的 provider fiber：

- fake adapter Scope 关闭；
- owning turn Scope 关闭；
- 当前 `discoverModels`、`generate` 或 `continue` 调用方被中断。

中断完成后 gate 被移除、`activeRequests` 递减，并发布 `RequestCancelled`。adapter Scope 关闭还会清空 continuation store。所有这些同步使用 Effect `FiberSet`、`Deferred`、`Queue` 和 `Ref`，不使用真实时间或任意 sleep。

`blocked: true` 的 step 在发布 `RequestStarted` 并计入 active 后等待 `release(requestId)`，适合验证并发 claim、caller interruption 和作用域关闭；`blocked: false` 则直接执行已脚本化的结果。

## 6. Vitest 契约套件

真实 adapter 在自己的测试工作区提供 `AdapterConformanceFactory`，然后显式注册：

```ts
import { defineAdapterConformanceSuite } from 'yokai-adapter-conformance/vitest'

defineAdapterConformanceSuite('Gemini YokaiAdapter', geminiConformanceFactory)
```

通用套件负责验证供应商无关的可观察契约，包括：

- descriptor Schema 与协议握手；
- 模型 ID 和 generation methods 去重、稳定排序、逐模型 freshness、元数据缺失保持缺失；
- 快照内容等价比较只排除 `discoveredAt`，后续刷新不回写先前快照；
- single-pass 文本以及 ToolCallBatch → 单次 continue → 最终文本，且每阶段 usage 为本次逻辑生成成功响应的增量；
- 结果按 call ID 恢复首次调用顺序；
- continuation 绑定原 adapter 实例、model 和 owning Scope，并在重复、并发、跨 adapter 与 Scope 关闭时失效；
- provider 前错误请求数为零；合法 `generate` 或 `continue` 各只形成一次同模型逻辑生成，通用立即成功
  fixture 各消费一个物理 step；adapter 专属的等价端点尝试可以多于一次但必须有界，再次 ToolCall 不产生
  第三次逻辑生成；
- caller interruption保持 Effect interruption，provider-reported cancellation 与其他注入错误映射为封闭错误分类；
- 普通发现与生成不产生 capability probe，错误和事件不泄漏不可信 provider message 或 continuation。

套件用 factory control 观察真正的 provider stub 边界。真实 adapter 的 factory 不能只在 `YokaiAdapter` 外层伪造计数或取消事件，否则无法证明 SDK/HTTP 调用次数与取消传播。

## 7. 验收边界

通过通用套件证明的是 YK-002 协议在给定 adapter 实现上的供应商无关行为。以下内容仍由各 adapter 的专属测试负责：

- SDK/HTTP wire mapping、分页 token、连接或 endpoint 路由、认证配置和供应商响应解码；
- Effect interruption 是否最终转换为该 SDK 或 HTTP 客户端实际使用的 `AbortSignal`；
- 哪一种真实 SDK/HTTP 失败触发 setup 中的哪一个通用错误分类；
- 供应商私有历史、thought signature 或 function response 是否无损保存在 continuation state；
- 供应商专属重试/故障转移规则、同模型端点尝试上界、分页切换后的重启、超时重复计费风险、
  HTTP 配置继承、完整响应期间的取消与资源释放，以及密钥脱敏。

确定性 fake 是通用套件和主体集成测试的参考实现，不替代真实 adapter 自己运行同一套 conformance suite。仅让 fake 通过不能证明 Gemini 或其他 adapter 合规。

`discoverModels` 的零参数公共签名以及 fake 的依赖图可以证明测试参考实现没有消息、人格、记忆或发送权限输入；黑盒套件无法证明真实 adapter 没有从闭包或全局读取额外权限。真实 adapter 仍须通过包级依赖审查和专属测试证明这一点。

“不可变快照”在本任务中指 adapter 后续刷新不会修改已经返回的快照内容，不要求运行时 `Object.isFrozen`。`adapterModelSnapshotContentEqual` 使用完整 `models` 内容比较，只排除刷新时间 `discoveredAt`；freshness、availability、显示名、token limits 和 generation methods 都参与比较。

## 8. 明确不包含 registry revision

YK-003 的对象是单个 adapter 的发现快照和调用契约。本包不实现、分配或比较主体全局模型目录的 revision，也不定义 adapter 的 discovering、ready、stale、offline 或 failed 注册表状态。

以下职责明确留给 YK-009 能力注册表及 YK-011 实时模型目录：

- adapter 注册、注销、同 ID 冲突和回合能力快照；
- 多 adapter 模型快照合并、`SubscriptionRef` 发布和单调递增目录版本；
- 内容无变化时抑制 revision 增长，以及迟到刷新结果的代际校验；
- 单模型选择、不可用模型保留和配置 Schema 动态更新；
- adapter 级刷新中、离线、失败等主体状态。

`AdapterModelSnapshot.discoveredAt`、测试事件 `requestId`、fake `tokenNamespace` 与 continuation 序号都不是 registry revision，不能被主体拿来替代全局目录版本。
