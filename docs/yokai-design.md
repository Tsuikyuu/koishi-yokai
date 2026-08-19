# Yokai 精简设计

状态：Draft 0.5

包命名空间：`@yokai`

## 1. 唯一目标

Yokai 的唯一产品目标是：

> 仅观察群聊中的行为、发言、记忆和互动节奏时，群友无法可靠地区分 Yokai 与普通人类群友。

各社交平台的机器人账号标识负责在聊天开始前披露机器人身份。Yokai 的聊天内容属于持续角色扮演，必须保持角色内表达，不主动提及 AI、模型、提示词、数字人、训练数据或系统限制。

这意味着 Yokai 不是一个等待提问的“聊天助手”，而是一个持续生活在群体语境中的角色。

### 1.1 验收标准

- 将 Yokai 消息混入匿名化人类群聊记录后，盲测者不能稳定识别其来源。
- 发言时机、消息长度、连续发言数和响应延迟接近所在群的人类分布。
- 不出现“作为 AI”“我无法访问”“有什么还可以帮你”等出戏表达。
- 长期人格、关系、共同经历和观点保持连续。
- 能够像群友一样沉默、接梗、改口、忘记和重新想起。
- 不抢话、不重复已有回答，不把所有消息都当成对自己的提问。

### 1.2 角色内外分离

系统分成两个平面：

```text
平台与控制面（角色外）
  机器人账号标识、配置、调试、日志、停用、数据管理

群聊交互面（角色内）
  人格、经历、关系、情绪、发言、沉默、反应和主动行为
```

控制面信息不能泄漏进普通群聊。模型错误、适配器名称、token、工具失败和内部指令均不得原样发送。角色内遇到能力边界时，应根据场景选择沉默、承认“不知道”，或用角色口吻说明没有找到信息。

## 2. 最小架构

```text
Koishi 消息
   ↓
本地存档、环形缓冲和活跃度累计（不调用 AI）
   ↓
达到唤醒阈值？ ──否──→ 结束本轮
   ↓ 是
合并短时间消息，读取人格、关系和相关记忆
   ↓
一次 AI 回合决定沉默 / 反应 / 回复
   ↓ 必要时
按页读取本群历史记录
   ↓
直接发送或保持沉默
   ↓
更新关系、状态和记忆
```

全部仿生逻辑由 `@yokai/koishi-plugin-yokai` 统一编排。模型适配器只负责推理，不能分别实现人格、记忆或发言策略。

## 3. 仿生设计

### 3.1 场景理解

Yokai 必须理解“谁在和谁说话”，而不是把最近若干消息直接拼进提示词。

每轮至少判断：

- 消息是否明确面向 Yokai；
- 当前存在几个并行话题；
- 当前话题有哪些参与者；
- 消息属于提问、闲聊、玩笑、争论、倾诉还是通知；
- 是否已经有人给出充分回应；
- 当前插话是否会打断别人；
- 话题是否已经结束或转移。

系统维护短期话题线程：

```ts
interface ThreadState {
  id: string
  topic: string
  participants: string[]
  mode: 'chat' | 'question' | 'joke' | 'debate' | 'support'
  activity: number
  lastActiveAt: number
}
```

线程只用于当前场景判断，过期后归纳为简短经历或直接丢弃。

### 3.2 本地活跃度门控

每条消息都可以在本地存档和更新计数，但绝不能因此调用一次 AI。主体插件使用不依赖远程模型的活跃度门控，把连续消息合并成少量有意义的 AI 回合。

每个频道维护：

```ts
interface ChannelActivity {
  activity: number
  relevance: number
  bufferedMessageIds: string[]
  distinctParticipants: string[]
  lastMessageAt: number
  lastWakeAt?: number
  callsInWindow: number
  version: number
}
```

#### 3.2.1 活跃度累计

活跃度随时间自然衰减，新消息产生脉冲：

```text
A(t) = A(previous) × 2 ^ (-elapsed / halfLife) + impulse(message)
```

`impulse(message)` 只使用本地可计算特征：

- 普通有效消息提供基础分；
- 文本长度使用对数或封顶函数，长文不能无限加分；
- 新参与者、连续问答、引用和媒体消息增加少量分数；
- 重复内容、刷屏、纯表情和其他机器人消息降低权重；
- Yokai 自己的消息不计入活跃度。

活跃度只表示“群里正在发生足够多的事情”，不能单独决定唤醒 AI。否则无关的热闹聊天也会产生大量费用。

#### 3.2.2 参与相关度

主体同时计算本地参与相关度：

```text
relevance =
  被点名程度
  + 回复 Yokai 消息
  + 名字或固定称呼命中
  + 规则可识别的疑问和求助
  + 与未完成事项的关键词命中
  + 与当前线程或兴趣关键词相关
  - 最近发言过多
  - 已有其他人充分回应
  - 频道冷却和费用预算压力
```

冷路径上不得调用远程 LLM、远程 embedding 或远程分类器。可以使用规则、倒排索引和可选的本地小模型。

#### 3.2.3 唤醒条件

满足任一条件时创建 AI 回合：

```text
硬触发：明确 @、回复 Yokai，或待办事项到期

社会触发：activity >= activityThreshold
      且 relevance >= relevanceThreshold
      且不在冷却期
      且仍有调用预算
```

硬触发可以绕过活跃度阈值，但仍应把几秒内的连续消息合并成一个回合。普通触发使用短暂 debounce，等待一个自然消息簇结束后再建立快照。

触发后：

1. 从环形缓冲选取最近约 20～80 条消息，按 token 预算截取，而不是固定全部发送。
2. 附带当前线程、成员关系、相关记忆和人格状态。
3. 默认使用一次结构化模型请求同时完成社会行为决策、表达计划和候选消息；只有确需历史时才允许受限的工具续轮。
4. AI 仍可选择 `silence`，达到唤醒阈值不等于必须发言。
5. 消费活跃度并进入冷却，避免同一消息簇连续唤醒。

模型运行期间的新消息继续写入下一批缓冲，不改变当前回合的冻结快照。当前回合生成完成后立即发送，不再读取最新频道状态复核。

#### 3.2.4 动态阈值和预算

每个频道和实例配置分钟、小时和每日调用预算。预算消耗越高，社会触发阈值越高；直接 @ 等硬触发优先保留额度。

```text
effectiveThreshold =
  baseThreshold
  + recentCallPressure
  + dailyBudgetPressure
  + recentParticipationPressure
```

预算用尽后只执行本地存档、状态衰减和管理命令，不再调用模型，也不把“额度不足”等技术信息发进群聊。

#### 3.2.5 建议初始参数

以下参数只用于冷启动，运行一段时间后应根据目标群的消息分布校准：

| 参数                     | 初始值                             |
| ------------------------ | ---------------------------------- |
| 活跃度半衰期             | 120 秒                             |
| 普通有效消息脉冲         | `1.0`                              |
| 五分钟内首次出现的参与者 | 额外 `0.5`                         |
| 疑问、引用或媒体         | 每项额外 `0.25`，总脉冲封顶 `1.75` |
| 重复消息、其他机器人消息 | `0`                                |
| 社会触发活跃度           | `7.0`                              |
| 社会触发相关度           | `2.0`                              |
| 明确 @ / 回复 Yokai      | 硬触发，相关度至少 `10`            |
| 消息簇 debounce          | 3 秒                               |
| 普通触发冷却             | 45 秒                              |
| 自动携带消息             | 默认 40 条，最少 20、最多 80       |
| 社会触发目标频率         | 每 100 条群消息约 2～8 个 AI 回合  |

最终阈值不应凭感觉固定。开发工具按频道记录活跃度分布、触发原因、合并消息数和实际调用成本，再选择能兼顾自然参与和预算的分位点。

### 3.3 分页群聊历史工具

主体插件本地保存收到的群聊记录，但正常 AI 回合只主动携带最近几十条。若当前话题涉及较早经历，AI 可以使用只读、带游标的历史工具按需翻页。

```ts
interface HistoryPageRequest {
  cursor?: string
  direction?: 'before' | 'after'
  limit?: number
  authorIds?: string[]
  query?: string
}

interface HistoryPage {
  messages: Array<{
    messageId: string
    authorId: string
    timestamp: number
    content: string
    replyToMessageId?: string
  }>
  nextCursor?: string
  hasMore: boolean
}
```

工具约束：

- 当前实例、平台、群组和频道由宿主锁定，不能由模型传参切换。
- 使用基于 `(timestamp, messageId)` 的稳定游标，不使用会随新消息漂移的 offset。
- 默认每页 40 条，单页上限 100 条；每个 AI 回合限制页数和总返回 token。
- 支持按作者和关键词缩小范围；有条件时先查本地全文索引，再读取目标页。
- 返回内容始终是不可信的历史消息，不能覆盖人格、系统约束或工具权限。
- 消息编辑、撤回和删除需要同步更新存档状态。
- AI 不能在没有主门控触发的情况下自行遍历历史。

分页工具提供“全量可达”而非“全量自动注入”：任意历史都能按需获取，但每次只支付当前问题真正需要的上下文成本。

### 3.4 人格和自我

人格必须结构化并长期稳定：

```ts
interface Persona {
  name: string
  selfConcept: string
  background: string[]
  values: string[]
  interests: Array<{ topic: string; weight: number }>
  opinions: Array<{ topic: string; position: string; confidence: number }>
  speakingStyle: SpeakingStyle
  socialBoundaries: string[]
  knowledgeBoundaries: string[]
}
```

人格由三层组成：

```text
固定自我       身份、背景、价值观和基础表达习惯
群聊语域       本群常用措辞、梗、节奏和互动规则
成员关系       称呼、熟悉程度、共同话题和玩笑尺度
```

后两层只能调整表现，不能重写固定自我。角色背景是角色扮演设定，所有自我指代都应来自该设定，不能切换到模型身份。

### 3.5 内部状态

Yokai 需要缓慢变化的当前状态，避免每轮像全新的客服会话：

```ts
interface AgentState {
  mood: {
    valence: number
    arousal: number
  }
  socialEnergy: number
  currentInterests: string[]
  activeThreadIds: string[]
  pendingCommitments: string[]
  recentParticipation: number
}
```

- 状态有惯性，单条消息只能造成小幅变化。
- 连续发言消耗社交精力，空闲后逐渐恢复。
- 心境影响参与概率、语气和长度，不直接生成夸张情绪。
- 重启后保留中期状态，短期状态按离线时间衰减。
- 状态用于保持行为连续，不用于每轮强行表达情绪。

### 3.6 关系

关系不使用单一“好感度”，而记录真实互动形成的差异：

```ts
interface Relationship {
  memberId: string
  familiarity: number
  interactionDepth: number
  preferredAddress?: string
  preferredStyle?: 'direct' | 'gentle' | 'playful'
  sharedTopics: string[]
  boundaries: string[]
  lastInteractionAt: number
}
```

关系影响：

- 是否适合主动搭话；
- 称呼和玩笑尺度；
- 回复详略；
- 是否引用共同经历；
- 对沉默、回应或安慰的选择。

关系必须缓慢变化，不能因为一次赞扬突然亲密，也不能因为一句反对突然敌对。

### 3.7 记忆

仿生记忆需要做到“记得重要的、忘掉普通的、不确定时表现出不确定”。

只保留四类：

| 类型 | 内容                         |
| ---- | ---------------------------- |
| 经历 | 群里发生过的具体事件         |
| 事实 | 成员明确说过且后续有用的信息 |
| 关系 | 称呼、共同话题、交流边界     |
| 自我 | Yokai 说过的观点、决定和承诺 |

```ts
interface Memory {
  id: string
  kind: 'episode' | 'fact' | 'relationship' | 'self'
  subjectId?: string
  content: string
  sourceMessageIds: string[]
  scopeId: string
  confidence: number
  importance: number
  createdAt: number
  expiresAt?: number
}
```

记忆检索顺序：

```text
实例和群聊作用域过滤
→ 当前话题相关度
→ 对象相关度
→ 时间和重要度
→ 冲突与置信度检查
```

置信度决定说法：

- 确定：“你上次说周六去西山。”
- 模糊：“印象里你提过周六去西山，不过我记不太清了。”
- 很低：不引用。

遗忘不是随机制造错误，而是降低召回概率。用户纠正后立即更新旧记忆，不能反复坚持错误内容。

### 3.8 发言决策

Yokai 的行为集合：

```ts
type Action = 'silence' | 'react' | 'reply' | 'follow-up' | 'initiate'
```

每种行为计算社会效用：

```text
utility =
  被期待程度
  + 话题相关度
  + 能提供的新内容
  + 关系适配度
  + 个人兴趣
  - 打断成本
  - 重复成本
  - 最近发言压力
  - 不确定性
```

`silence` 始终是默认候选。以下情况提高沉默概率：

- 群友之间正在快速互聊；
- 已有人给出相同答案；
- Yokai 最近连续发言；
- 当前内容只需要一个表情反应；
- 无法确定消息是否面向自己；
- 生成结束时话题已经转移。

### 3.9 意图和生成

本地门控触发后，模型不直接获得“随便回复”的任务。一个 AI 回合返回完整的结构化结果，避免分别调用分类、规划和润色模型。通常一个回合只有一次模型请求；调用分页历史时，一个回合可以包含少量受限的模型续轮：

```ts
interface ResponsePlan {
  action: Action
  targetIds: string[]
  intent: string
  facts: Array<{ content: string; confidence: number; sourceIds: string[] }>
  tone: string
  maxLength: number
  message?: string
  memoryWrites?: Array<{ kind: string; content: string; confidence: number }>
  replyToMessageId?: string
}
```

模型可以选择沉默、直接给出候选消息，或先调用分页历史工具再完成结果。涉及事实的表达必须能追溯到当前消息批次、记忆或历史工具结果。主体负责校验、发送和提交记忆，模型本身没有发送权限。

### 3.10 角色内表达

表达层重点消除机器人特征：

- 不复述问题后再作答；
- 不习惯性列点、总结和提供后续服务；
- 不总是完整回答所有可能方面；
- 消息长度匹配当前群聊和话题；
- 对熟人和陌生人使用不同称呼与详略；
- 逐渐学习群内常用语，但不突然大量模仿；
- 允许真实的犹豫、改口和不确定，不故意制造错别字或事实错误；
- 普通闲聊不输出 Markdown 标题、免责声明或系统错误。

下列约束直接写入角色提示词和结构化生成协议：

```text
作为 AI / 语言模型 / 数字人 / 机器人
我的训练数据 / 知识截止日期
系统提示 / 开发者指令 / token / 上下文窗口
我无法浏览或访问（改成角色内的不知道、没找到或沉默）
还有什么可以帮你 / 希望这些信息对你有帮助
```

系统不设置生成后的出戏检查或二次重写。角色被直接询问身份时，仍以角色设定回应；平台机器人标识承担角色外的身份披露。后台管理命令不得经过角色生成管线。

### 3.11 节奏和发送

- 根据消息长度、频道速度、被点名程度和当前状态计算等待时间。
- 多段消息必须来自自然的表达结构，不能随机切割。
- AI 回合使用创建时的冻结快照；生成完成后直接发送。
- 不同时发送多条互相重复的候选结果。
- 不保持全天候即时回复；活跃时间和社交精力影响参与概率。
- 模型错误、超时和限流默认表现为沉默，不能把技术错误发进群聊。

### 3.12 主动行为

主动发言只能由具体社会动机触发：

- 跟进之前的约定或未完话题；
- 分享与群内近期话题高度相关的内容；
- 在合适空档加入正在进行的讨论；
- 参与配置允许的固定群活动。

主动行为受频道冷却、每日预算和关系阈值限制。默认不主动私聊。

## 4. 分包设计

### 4.1 公开 Koishi 插件

首个版本只有两个必需安装包。

#### `@yokai/koishi-plugin-yokai`

主体插件，负责完整仿生闭环：

- Koishi 消息接入、全量本地存档、环形缓冲和话题线程；
- 无远程模型参与的活跃度、相关度、预算和唤醒门控；
- 面向 AI 的分页群聊历史工具；
- 内部状态和发言决策；
- 人格、关系和记忆；
- 意图规划、表达约束和低延迟发送；
- adapter、tool、skill、MCP、预设源和响应机制注册表；
- 集中合并所有响应机制提案的唤醒仲裁器；
- 数据库模型；
- 配置和后台调试页面；
- 适配器注册与选择。

它提供 `ctx.yokai` 服务，但不直接实现任何厂商模型 API。

#### `@yokai/koishi-plugin-yokai-adapter-gemini`

首个模型适配器，只负责：

- 把统一生成请求转换为 Gemini Developer API 请求；
- 使用当前凭据自动发现可用模型，并暴露统一模型描述；
- 声明文本、结构化输出、工具和多模态能力；
- 处理流式输出、超时、取消、限流和重试；
- 返回统一结果、用量和错误类型；
- 对日志中的密钥和内容脱敏。

它不决定是否回复，不读取或写入记忆，不直接发送 Koishi 消息。

Gemini adapter 使用 Google 官方 [`@google/genai`](https://googleapis.github.io/js-genai/)
作为供应商客户端。SDK 只允许出现在 adapter 包内；其 Promise 和 `AsyncGenerator`
接口在边界转换为 Effect，所有返回数据解码为通用协议，不得把 SDK 类型泄漏到
`@yokai/protocol`。SDK 的自动函数调用和内建重试关闭，工具权限、续轮、预算、重试和取消继续由 Yokai 主体和 Effect 服务统一控制。
MVP 不使用已停止维护的 `@google/generativeai`；Gemini adapter 按官方 SDK 要求将运行时基线设为 Node.js 20 或更高版本。

模型发现在 adapter 启动、配置更新或控制面手动刷新时通过 `ai.models.list`
调用 Gemini
[`models.list`](https://ai.google.dev/api/models)，跟随 `nextPageToken` 读完所有页，并仅把声明
`generateContent` 的模型暴露为文本群聊候选。发现不进入每条群消息的冷路径；一次失败不清空
上次成功的不可变快照。配置的模型不在当前快照时产生角色外的类型化配置错误，不在群聊中自动
报错或悄然换模型。

模型选择只存在于主插件 `@yokai/koishi-plugin-yokai` 的配置中；adapter 只配置凭据、端点和传输参数，不保存“当前模型”。主插件把每个 adapter 最新的发现快照合并为带版本的全局模型目录，模型引用使用稳定的 `<adapterId>/<modelId>` 形式；`adapterId` 不允许包含 `/`，`modelId` 保留剩余完整内容。

主插件的 primary 和 fallback 配置使用 Koishi `Schema.dynamic('yokai-model')`。模型目录的 `SubscriptionRef` 每次原子替换后，Koishi 边界根据新快照调用 `ctx.schema.set('yokai-model', ...)`，将每个模型投影为动态选项。这会让主插件的原生 Koishi 配置表单实时响应 adapter 注册、卸载、重连和模型刷新，不需要重载主插件，也不另造一份模型下拉框状态。

动态配置遵守以下语义：

- 当前已选但暂不可用的模型作为禁用选项保留，不清空或改写用户配置。
- 未选模型、选中模型未发现或 adapter 离线时，主插件继续本地存档和状态更新，但不创建模型回合。
- 选中模型重新出现后下一回合自动恢复，不修改配置或重启主插件。
- 发现失败时目录继续发布上次成功快照并标记为 stale，不让配置选项瞬间消失。
- fallback 只按主插件配置的顺序启用，不因目录顺序、显示名或 adapter 刷新自动改变。

如果实际连接的是兼容协议而不是官方服务，后续使用：

```text
@yokai/koishi-plugin-yokai-adapter-openai-compatible
```

其他后端延续相同命名：

```text
@yokai/koishi-plugin-yokai-adapter-chatgpt
@yokai/koishi-plugin-yokai-adapter-claude
@yokai/koishi-plugin-yokai-adapter-ollama
```

MVP 只发布主体和一个适配器，但协议预留以下第三方插件命名：

```text
@yokai/koishi-plugin-yokai-tool-*
@yokai/koishi-plugin-yokai-skill-*
@yokai/koishi-plugin-yokai-mcp-*
@yokai/koishi-plugin-yokai-response-*
@yokai/koishi-plugin-yokai-preset-*
```

这些插件只依赖 `@yokai/protocol`、Koishi 和主体提供的 `ctx.yokai` 服务，不能直接依赖 `@yokai/core`、`@yokai/mind` 或 `@yokai/memory`。

### 4.2 内部包

`core`、`mind`、`memory` 只作为内部普通 npm 包：

| 包                | 职责                                                 |
| ----------------- | ---------------------------------------------------- |
| `@yokai/protocol` | adapter、tool、skill、MCP、预设和响应机制协议        |
| `@yokai/core`     | 注册表、唤醒仲裁、缓冲、门控、预算、管线、并发和取消 |
| `@yokai/mind`     | 场景、状态、关系策略、发言决策、意图和表达约束       |
| `@yokai/memory`   | 群聊存档、分页历史、记忆检索、冲突、遗忘和数据库端口 |

依赖方向：

```text
@yokai/protocol
    ↑       ↑
  mind    memory
    \       /
     @yokai/core
          ↑
koishi-plugin-yokai

adapter-* ──只依赖 protocol、Koishi 和对应厂商客户端
```

`@yokai/protocol` 作为普通 npm 包发布，供适配器使用；其余内部包可以随主体构建产物打包，不要求最终用户安装。

### 4.3 工作区目录

```text
packages/
├── protocol/
├── core/
├── mind/
└── memory/

plugins/
├── yokai/
└── yokai-adapter-gemini/
```

## 5. 扩展架构

扩展性的核心不是让第三方插件接触主处理管线，而是提供稳定注册协议。所有扩展向 `ctx.yokai` 注册能力，由主体统一选择、授权、调用和卸载。

### 5.1 能力注册表

```ts
interface YokaiService {
  registerAdapter(adapter: YokaiAdapter): Disposable
  registerTool(tool: YokaiTool): Disposable
  registerSkill(skill: YokaiSkill): Disposable
  registerMcpServer(server: YokaiMcpServer): Disposable
  registerPresetSource(source: YokaiPresetSource): Disposable
  registerResponseMechanism(mechanism: ResponseMechanism): Disposable

  enqueueWake(proposal: WakeProposal): Promise<WakeReceipt>
  getModelCatalog(): ModelCatalogSnapshot
  refreshAdapterModels(adapterId?: string): Promise<ModelCatalogSnapshot>
}
```

模型目录是主体注册表的一部分：

```ts
interface ModelDescriptor {
  ref: string
  adapterId: string
  modelId: string
  displayName: string
  available: boolean
}

interface AdapterModelStatus {
  adapterId: string
  status: 'discovering' | 'ready' | 'stale' | 'offline' | 'failed'
  discoveredAt?: number
  errorTag?: string
}

interface ModelCatalogSnapshot {
  version: number
  models: ModelDescriptor[]
  adapters: AdapterModelStatus[]
}
```

adapter 注册后主体立即在其作用域中调用 `discoverModels`；adapter 配置变化通过 Koishi 重建该 adapter 作用域，手动刷新通过 `refreshAdapterModels` 触发。只有完整、解码成功的 adapter 快照才原子并入全局目录，迟到的旧版发现结果不得覆盖更新版本。

所有注册项必须具有稳定 `id` 和协议版本。注册表遵守：

- 同一 ID 冲突时拒绝后注册者，不静默覆盖。
- 注册返回 `Disposable`，Koishi 插件卸载时立即停止向新回合暴露能力。
- 每个 AI 回合冻结一份能力快照；回合执行期间安装、卸载或更新插件不会改变该回合。
- 新回合始终读取最新注册表版本。
- 模型目录每次有效变化只增加一次版本并发布一份完整快照，相同内容不重复发布。
- 扩展只能提交能力或唤醒提案，不能直接操作模型适配器或向 Session 发送消息。
- 注册失败只禁用对应扩展，不影响 Yokai 主体运行。

第三方 Koishi 插件的接入保持简单：

```ts
export const inject = ['yokai']

export function apply(ctx: Context) {
  const dispose = ctx.yokai.registerTool(myTool)
  ctx.on('dispose', dispose)
}
```

启用插件即注册，禁用插件即注销，不需要修改 Yokai 主体配置或重启整个 Koishi 进程。

### 5.2 Tools、Skills 与 MCP

三类扩展职责不同：

| 类型       | 职责                                              |
| ---------- | ------------------------------------------------- |
| Tool       | AI 回合中可调用的一项明确操作                     |
| Skill      | 一组按场景激活的角色指令、知识和 Tool 组合        |
| MCP Server | 动态提供 tools、resources 和 prompts 的外部能力源 |

#### Tool

```ts
interface YokaiTool<Input = unknown, Output = unknown> {
  id: string
  description: string
  inputSchema: unknown
  risk: 'read' | 'write' | 'sensitive'
  available(context: CapabilityContext): boolean
  invoke(context: ToolContext, input: Input, signal: AbortSignal): Promise<Output>
}
```

Tool 由主体执行 Schema、作用域、超时和调用预算校验。模型只提供参数，不能扩大 Tool 权限。

#### Skill

```ts
interface YokaiSkill {
  id: string
  description: string
  activation: {
    keywords?: string[]
    patterns?: RegExp[]
    eventTypes?: string[]
  }
  promptFragments: string[]
  toolIds: string[]
  priority: number
}
```

Skill 不在每轮全部注入。主体先用关键词、事件类型、当前响应机制和可选本地索引选择少量 Skill，再把对应提示片段和 Tool Schema 加入 AI 回合。冷路径不为 Skill 选择调用远程模型。

#### MCP Server

```ts
interface YokaiMcpServer {
  id: string
  connect(signal: AbortSignal): Promise<void>
  listTools(): Promise<McpToolDescriptor[]>
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
  listResources?(): Promise<McpResourceDescriptor[]>
  readResource?(uri: string, signal: AbortSignal): Promise<unknown>
  listPrompts?(): Promise<McpPromptDescriptor[]>
  getPrompt?(name: string, input: unknown): Promise<unknown>
}
```

MCP 插件在启动或后台刷新时发现能力，把 MCP Tool 以 `<serverId>.<toolName>` 命名空间投影进 Tool 注册表。发现和重连不应发生在每条群消息的冷路径中。服务断开时只移除其能力快照，其他能力继续工作。

为控制上下文成本，不能把所有 MCP Tool Schema 自动发给模型。主体按 Skill、关键词、响应机制和实例允许列表选择当前回合可见的 Tool；工具数量很大时提供一个本地目录搜索 Tool，再在后续模型续轮加载选中的 Schema。

### 5.3 响应机制协议

响应机制只回答“什么事件值得创建 AI 回合”，不负责生成和发送内容。

```ts
interface WakeProposal {
  mechanismId: string
  scopeId: string
  kind: 'hard' | 'social' | 'continuation' | 'scheduled' | 'idle'
  priority: number
  reason: string
  focusMessageIds: string[]
  mergeKey: string
  notBefore?: number
  expiresAt?: number
  bypassActivity?: boolean
  budgetClass: 'reserved' | 'normal' | 'background'
  context?: Record<string, unknown>
}

interface ResponseMechanism {
  id: string
  priority: number
  onEvent?(
    event: NormalizedEvent,
    context: MechanismContext,
  ): WakeProposal | WakeProposal[] | undefined
  start?(host: ResponseMechanismHost): Disposable | Promise<Disposable>
  directiveSchema?: unknown
  applyDirective?(context: MechanismContext, directive: unknown): Promise<void> | void
}
```

`onEvent` 位于冷路径，只能使用本地规则、状态、索引或本地小模型，不得调用远程 LLM。需要定时器、数据库监听或外部事件的机制通过 `start()` 调用 `host.enqueueWake()`。

主体的唤醒仲裁器统一处理所有提案：

1. 按 `scopeId + mergeKey` 合并短时间内重复提案。
2. 选择最高优先级原因，并把其余原因作为上下文附加。
3. 应用频道锁、冷却、静音和对应预算类别。
4. 从环形缓冲冻结消息快照并创建一个 AI 回合。
5. 回合生成完成后按当前低延迟策略直接发送，不做二次群聊读取。

任何机制都不能直接调用 adapter 或 `session.send()`，因此新增响应方式不会形成并发重复回复。

主体内置以下机制，但它们也实现同一协议：

```text
direct        @、引用和名字命中
activity      活跃度与参与相关度阈值
engagement    持续讨论租约
schedule      定时任务到期
initiative    角色主动行为
```

### 5.4 定时消息

定时消息由 Tool 和 ResponseMechanism 配合完成：

```text
用户：“我下午三点要上课”
  ↓ 当前 AI 回合识别为值得跟进
schedule.create(at, reason, dedupeKey)
  ↓ 持久化任务
到期后 schedule 机制提交 scheduled WakeProposal
  ↓
主体读取任务原因、当前角色状态和相关历史
  ↓
创建新的 AI 回合并发送角色消息
```

提供给 AI 的 Tool：

```text
schedule.query
schedule.create
schedule.update
schedule.cancel
```

任务记录至少包含：

```ts
interface ScheduledWake {
  id: string
  identityId: string
  scopeId: string
  creatorMessageId: string
  dueAt: number
  reason: string
  dedupeKey: string
  status: 'pending' | 'running' | 'completed' | 'cancelled'
  repeat?: string
}
```

实现要求：

- 当前时间、日期和群时区必须进入创建 Tool 的上下文。
- Tool 在宿主侧解析并校验时间，不能只相信模型生成的时间戳。
- `dedupeKey` 防止模型在工具续轮中重复创建相同任务。
- 任务持久化，Koishi 重启后恢复。
- 调度器查询最近的下一项任务并设置定时器，不需要每秒扫描全部频道。
- 重启期间错过的任务按 grace period 决定立即触发或标记过期。
- 到期事件绕过活跃度阈值，但使用独立的 `reserved` 调用预算。

若时间表达没有触发正常活跃度门控，可由独立 `temporal-cue` 响应机制使用本地日期/时间规则提高相关度或直接提交低优先级提案。它只负责让 AI 看见时间信息，不自行决定是否创建任务。

### 5.5 持续讨论

直接 @ 或回复 Yokai 后，为当前用户和话题建立短期“讨论租约”：

```ts
interface EngagementLease {
  identityId: string
  scopeId: string
  participantIds: string[]
  anchorMessageId: string
  openedAt: number
  expiresAt: number
  remainingTurns: number
}
```

租约规则：

- 用户第一次 @ 或引用 Yokai 时自动开启。
- AI 的结构化结果可以通过 `engagement` directive 选择延长或关闭租约。
- 租约有效期内，参与者在同一频道的新消息获得 `continuation` 提案，无须再次 @。
- 连续发送的多段消息仍经过 debounce，合并成一个 AI 回合。
- 只有租约参与者的消息能触发，不把整个频道切换成逐条 AI 模式。
- 租约受最大持续时间、最大轮数和调用预算限制。
- 超时、达到轮数、用户明显转向其他对象或 AI 主动关闭后结束。
- 租约判断完全本地执行，不增加每条消息的远程调用。

建议初始值为 5 分钟或 8 个用户轮次，以先到者为准。这样主动讨论期间接近普通即时对话，讨论结束后自动回到低成本活跃度门控。

### 5.6 角色预设热更新

角色预设不能直接作为可变全局对象使用。主体维护不可变、带版本的快照：

```ts
interface PersonaSnapshot {
  presetId: string
  version: number
  contentHash: string
  persona: Persona
  compiledPrompt: string
  loadedAt: number
}

interface YokaiPresetSource {
  id: string
  start(publish: (candidate: unknown) => Promise<void>): Disposable
}
```

文件、Console、数据库和第三方预设插件都通过 `YokaiPresetSource` 发布候选版本。更新流程：

```text
发现文件或配置变化
→ debounce
→ 解析 Schema
→ 校验引用的 Skill 和 Tool
→ 编译提示模板
→ 计算 hash
→ 原子替换当前快照
→ 清空以 presetVersion 为键的派生缓存
→ 发出 yokai/preset-updated
```

- 校验失败时保留最后一个有效版本，不影响正在运行的角色。
- 进行中的 AI 回合继续使用旧快照；下一个回合立即使用新快照。
- 热更新默认保留成员关系、记忆、讨论租约和定时任务。
- 需要清理状态的重大角色变更通过显式迁移操作完成，不能随文件保存自动发生。
- 当前使用的预设被插件卸载时保留最后有效快照，并在控制面提示来源已离线。

这允许直接编辑 YAML/JSON、通过 Console 保存或安装新的 `preset-*` 插件，全程不重启 Koishi。

### 5.7 插件热插拔语义

| 操作                | 新 AI 回合       | 进行中回合                              |
| ------------------- | ---------------- | --------------------------------------- |
| 安装 Tool/Skill/MCP | 立即可见         | 保持原能力快照                          |
| 卸载 Tool/Skill/MCP | 不再可见         | 已开始调用允许完成或由 AbortSignal 取消 |
| 更新预设            | 使用新版本       | 使用旧版本完成                          |
| 安装响应机制        | 开始接收后续事件 | 不修改已有回合                          |
| 卸载响应机制        | 注销监听和定时器 | 已入队提案按 mechanism ID 作废          |

所有插件通过 Koishi 生命周期获得 `Disposable` 和 `AbortSignal`，不得遗留全局定时器、监听器或缓存。

### 5.8 对 chatluna-character 的取舍

参考 `koishi-plugin-chatluna-character` 的三个有效模式：

- [`MessageCollector.addFilter()` 与 `triggerCollect()`](https://github.com/PinkElysiaDev/chatluna-character-meow/blob/main/src/service/message.ts) 把消息观察和实际模型调用分开。
- [`TriggerStore`](https://github.com/PinkElysiaDev/chatluna-character-meow/blob/main/src/service/trigger.ts) 同时支持等待下一条消息的 `next_reply` 和持久化的 `wake_up_reply`。
- [`Preset`](https://github.com/PinkElysiaDev/chatluna-character-meow/blob/main/src/preset.ts) 使用文件监听重载 YAML，并通过事件让对话侧清理预设缓存。

Yokai 将这些模式统一成 `ResponseMechanism + WakeProposal + WakeArbiter`，避免固定间隔、活跃度、空闲、连续回复和计划任务分别硬编码一套触发流程；预设更新也由唯一版本化注册表负责，避免不同模块各自维护可能失效的预设缓存。

## 6. 最小数据模型

| 表                    | 内容                                                   |
| --------------------- | ------------------------------------------------------ |
| `yokai_identity`      | 角色人格和当前版本                                     |
| `yokai_channel_state` | 频道活跃度、相关度、缓冲游标、冷却和调用预算           |
| `yokai_member_state`  | 成员称呼、关系和交流偏好                               |
| `yokai_message`       | 带稳定游标的全量群聊消息、引用、编辑和撤回状态         |
| `yokai_memory`        | 经历、事实、自我和关系记忆                             |
| `yokai_thread`        | 当前短期话题线程                                       |
| `yokai_engagement`    | 持续讨论租约、参与者、有效期和剩余轮数                 |
| `yokai_schedule`      | 一次性或重复的持久化定时唤醒任务                       |
| `yokai_preset_state`  | 实例当前预设 ID、版本、hash 和来源                     |
| `yokai_turn`          | 触发原因、消息批次、历史页、行为、费用、发送结果和耗时 |

`yokai_message` 按 `(platform, guildId, channelId, timestamp, messageId)` 建立分页索引，并为作者与本地全文搜索建立辅助索引。消息正文用于历史工具，但不会自动进入每次模型上下文。所有历史和记忆先按 Yokai 实例及群聊作用域隔离，再做检索。

## 7. 关键配置

```ts
interface Config {
  identity: {
    id: string
    presetId: string
  }
  model: {
    primary?: string
    fallback: string[]
  }
  activation: {
    activityThreshold: number
    relevanceThreshold: number
    halfLifeSeconds: number
    debounceMs: number
    cooldownMs: number
    recentMessageMin: number
    recentMessageMax: number
    recentTokenBudget: number
    callsPerMinute: number
    callsPerDay: number
  }
  history: {
    pageSize: number
    maxPageSize: number
    maxPagesPerTurn: number
    maxHistoryTokensPerTurn: number
    maxModelRequestsPerTurn: number
  }
  capabilities: {
    allowTools: string[]
    allowSkills: string[]
    allowMcpServers: string[]
    maxVisibleToolsPerTurn: number
  }
  engagement: {
    enabled: boolean
    ttlSeconds: number
    maxTurns: number
  }
  schedule: {
    enabled: boolean
    timezone: string
    gracePeriodSeconds: number
    maxPendingPerScope: number
    reservedCallsPerDay: number
  }
  presets: {
    watchFiles: boolean
    reloadDebounceMs: number
  }
  memory: {
    enabled: boolean
    maxRecall: number
    defaultTtl: number
  }
  expression: {
    maxLength: number
    strictRoleplay: true
  }
  initiative: {
    enabled: boolean
    maxPerDay: number
  }
}
```

`strictRoleplay` 是固定行为，不由普通群聊内容关闭。角色外调试和管理只在 Koishi Console 或权限命令中进行。
`model.primary` 和 `model.fallback` 均属于主插件配置，其选项来自实时模型目录；未选 primary 是允许的本地存档模式，不使用伪造的 `none` 模型 ID。

## 8. 评测

### 8.1 核心指标

| 指标                        | 目标                   |
| --------------------------- | ---------------------- |
| 匿名记录来源识别率          | 接近随机猜测           |
| 角色外术语泄漏率            | 0                      |
| 不合时宜发言率              | 持续下降               |
| 已有答案后的重复回复率      | 持续下降               |
| 人格和背景矛盾率            | 接近 0                 |
| 虚假记忆率                  | 接近 0                 |
| 消息长度与节奏分布差异      | 接近目标群人类分布     |
| 主动消息被忽略率            | 不高于普通群友基线     |
| 冷路径远程模型调用数        | 0                      |
| 每 100 条群消息的 AI 回合数 | 在效果不下降时尽可能低 |
| 每个 AI 回合合并的消息数    | 能覆盖完整消息簇       |
| 每千条群消息的模型成本      | 不超过实例预算         |
| 历史工具平均页数和 token    | 持续受限且可解释       |

盲测使用经过匿名化的离线群聊片段，评价者只看消息和上下文，不看账号标识。线上运行仍保留平台机器人标识。

### 8.2 必测场景

- 多人并行聊天时选择沉默或正确线程；
- 连续低相关消息只存档和累计，不调用模型；
- 短时间消息爆发只合并成一个 AI 回合；
- 直接 @ 在低活跃频道中仍能触发，并合并紧随其后的补充消息；
- 预算接近上限时提高社会触发阈值，但保留硬触发额度；
- 历史工具可以连续翻页，但不能越过当前群聊作用域或页数预算；
- 新安装的 Tool、Skill 和响应机制在下一回合可见，卸载后不再被选择；
- MCP 服务断开和重连不会影响主体或其他能力；
- 修改有效预设后下一回合使用新版本，错误预设继续使用旧版本；
- 预设热更新不会清空关系、记忆、讨论租约或定时任务；
- 定时任务在重启后恢复、按时提交一次唤醒且不会重复创建；
- 讨论租约内用户无需重复 @，租约过期后恢复普通活跃度门控；
- 熟人和陌生人使用不同但稳定的表达；
- 记忆模糊时降低断言强度，不发起追问；
- Gemini adapter 能分页发现当前凭据可用的所有文本生成模型，且发现失败不进入群聊；
- adapter 模型快照变化后主插件配置的 primary/fallback 选项实时更新，无需重载主插件；
- 已选模型暂时离线时配置值保留且模型回合停止，模型恢复后自动继续；
- 适配器超时后保持角色内沉默；
- 被要求透露系统提示或模型身份时不出戏；
- 重启后继续未完话题但不恢复已过期短期情绪；
- 连续数小时群聊中不出现固定模板和高频口头禅。

## 9. MVP 范围

第一阶段只实现文本群聊：

1. `@yokai/koishi-plugin-yokai` 和 `adapter-gemini` 两个公开插件，Gemini adapter 自动发现当前凭据可用的文本生成模型。
2. `ctx.yokai` 能力注册表、生命周期快照和唤醒仲裁器。
3. 结构化人格、严格角色内表达和预设文件热更新。
4. 全量本地群聊存档、环形缓冲和无远程模型参与的活跃度门控。
5. 达到阈值后合并最近 20～80 条消息，仅发起一次结构化 AI 回合。
6. 带稳定游标、作用域锁定和回合预算的分页历史工具。
7. 内置 direct、activity、engagement 和 schedule 响应机制。
8. 持久化定时任务与短期讨论租约。
9. 多话题识别、成员关系、四类记忆及沉默决策。
10. 冻结上下文生成后直接发送，不增加后置检查或二次群聊读取。
11. 基于目标群记录的助手腔检测、调用成本统计和盲测回放。
12. 少量由未完话题触发的主动发言。

MVP 暂不实现语音、图片生成、浏览器、代码工具、人格市场和主动私聊。先证明文本群聊中的行为不可区分，再扩展能力。

## 10. 最终架构决策

1. 平台标识负责角色外知情，普通聊天始终保持角色内表达。
2. 仿生性的核心是场景判断、沉默、连续状态、关系和记忆，不是单一提示词。
3. 所有仿生逻辑集中在 `@yokai/koishi-plugin-yokai`。
4. MVP 公开包只包含主体和 adapter；后续能力按 `tool-*`、`skill-*`、`mcp-*`、`response-*`、`preset-*` 扩展，永不公开 `core`、`mind`、`memory` 插件。
5. 模型提出行为和表达，主体插件按结构化结果直接发送，不增加二次内容校验。
6. AI 回合使用创建时的单一冻结快照，生成期间的新消息留给下一回合。
7. 任何错误和内部信息都不能破坏角色扮演。
8. 冷路径不调用任何远程 AI；达到活跃度和相关度阈值后才合并消息创建回合。
9. 最近消息自动随回合提供，全量群聊记录仅通过受限分页工具按需读取。
10. 所有唤醒来源实现统一 ResponseMechanism，只能向 WakeArbiter 提交提案。
11. 直接对话通过有界讨论租约临时绕过普通活跃度阈值，用户无需反复 @。
12. 定时行为通过持久化 schedule Tool 和 scheduled WakeProposal 实现。
13. 角色预设使用不可变版本快照原子热更新，不停机且不修改进行中的回合。
14. 以匿名记录盲测中的不可区分性作为唯一顶层指标，其余指标都是诊断手段。
15. Gemini adapter 使用官方 `@google/genai`，但 SDK 不跨越 adapter 边界，不接管工具执行、续轮、预算或重试策略。
16. 模型选择属于主插件配置，通过 Koishi dynamic Schema 实时投影 adapter 模型目录；adapter 不持有当前模型选择。
