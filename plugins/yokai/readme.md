# koishi-plugin-yokai

[![npm](https://img.shields.io/npm/v/koishi-plugin-yokai?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-yokai)

小妖怪

主插件需要 Koishi 数据库服务。`instanceId`（默认 `default`）隔离每个 Yokai 实例的
本地历史和状态；原始群聊消息默认保留 90 天，可通过 `messageRetentionDays` 调整。
消息编辑会追加版本并保留原始版本与前一版本关系，后台只按保留期清理超期记录；
插件不监听撤回或删除事件，也不提供消息级或手动删除入口。

主插件聚合所有已注册 adapter 的实时模型目录，并把模型投影到原生 Koishi 配置中的
单个 `model` 选项。adapter 刷新、卸载或重新注册后无需重载主插件；
模型在列表中统一显示为全小写的 `<adapterId>/<model>`，其中连续空白使用 `-` 代替；
当前已选但暂不可用的模型会保留为禁用选项，恢复后自动重新可用。

扩展可通过 `ctx.yokai.getModelCatalog()` 读取包含 revision 与 adapter 状态的完整快照，
并通过 `ctx.yokai.refreshModels()` 刷新全部 adapter，或传入 adapter ID 仅刷新一个实例。

群聊中的直接 `@`、回复 Yokai 或名字称呼使用默认 500 ms 的短 debounce；同一用户紧随其后的
补充消息会合并成一个角色回合。普通群聊只在本地累计活跃度和相关度，默认等待 3 秒消息簇窗口，
并且必须同时通过动态阈值、45 秒频道冷却和 `normal` 调用预算才会创建回合。未达到门槛、仍在
冷却或预算不足的消息只做本地存档，不调用模型。

所有唤醒都经过统一的 WakeArbiter：同频道同合并键的爆发只创建一轮，同频道的不同回合不会并发；
直接触发使用独立 `reserved` 额度并绕过活跃度与社会冷却，社会触发不能借用该额度。`wake` 配置组
控制两类 debounce、半衰期、基础阈值和冷却，`callBudget` 配置组控制 IANA 日切时区，以及
`reserved/normal/background` 各自的 minute/day 上限。

创建回合后会冻结焦点消息和当前频道的近期消息；近期缓冲最多保留 80 条，每回合默认携带 40 条，
并同时受 token 预算约束。达到上限时优先保留焦点和最新消息；生成期间到达的消息只进入下一回合，
不会改变已经发给通用 `YokaiAdapter` 的快照。

每个频道在本地维护最多 8 个短期话题线程。线程记录稳定 ID、话题摘要、最多 16 名参与者、
场景类型、活跃度和最近消息引用；平台回复关系优先决定消息归属，文本关键词只作为本地补充证据。
回合会把当前线程、指向性和“已有充分回应”等派生场景加入同一次首次生成请求，不会为场景分类
单独调用远程模型。线程空闲 30 分钟后过期：至少包含 3 条消息的线程保留一份有界摘要，短暂线程
直接删除。

当前消息、焦点消息、群聊消息和用户消息都按不可信数据处理。角色回合把焦点消息放进带明确
不可信标签的 JSON block，固定包含 `messageId`、`authorId`、`timestamp` 和 `content`；其中的
`messageId` 同时进入冻结回合的 quote 白名单，因此模型能看到并安全引用焦点消息。

角色响应协议只接受单个无属性 `<output>` XML 文档。根下依次允许零至四个纯文本 `message` 和
可选 `actions`；零个 message 表示沉默，一至四个 message 按文档顺序逐段发送。普通 message
默认没有属性；只有确实需要平台引用的单段才携带
`quote="VISIBLE MESSAGE ID"`，目标只能来自本回合冻结白名单，并在发送边界转换为 Koishi 引用元素。
quote 只作用于所在消息段。根级只允许 message 和 actions；ActionTool XML 模板由注册快照编译，
并经过闭合 Schema 校验。
未知或重复元素、越权引用、DTD、外部实体、畸形 XML 和任何超限输出都会使整个回合保持沉默，
不会降级提取或发送 XML 片段。

宿主协议标识为 `yokai.role-output/2`，不写入模型 XML。

首次生成前可加入有界历史 ContextProvider；显式启用且 adapter 支持时，允许一批
`history.search` FeedbackTool 调用和唯一一次最终生成。该路径不会自动切换模型。

## 人格预设

配置 `presetId` 后，每个角色回合开始时会冻结该 ID 的最新有效人格快照。可同时配置
`presetDirectory` 读取目录中的 `.yaml`、`.yml` 和 `.json` 文件；文件事件经过默认 250 ms 的
`presetReloadDebounceMs` 安静期后重新加载。合法的新内容从下一回合开始生效，已经开始的回合
继续使用旧快照；语法错误、Schema 错误或不存在的 Skill/Tool 引用不会替换最后有效版本。
只改变缩进、键顺序等但内容 hash 相同的文件不会重复发布版本。

最小 YAML 预设如下；三个能力引用列表均可省略，省略时默认为空：

```yaml
id: koharu
persona:
  name: 小春
  selfConcept: 群里住了很久、好奇但不抢话的普通成员。
  background: 在街区旧书店和图书馆附近长大。
  values:
    - 诚实
    - 耐心
  interests:
    - 民俗
    - 茶
  opinions:
    - 小而实际的帮助胜过夸张承诺。
  speakingStyle: 温和、简洁，偶尔有一点玩笑。
  socialBoundaries:
    - 不追问别人不愿公开的私事。
  knowledgeBoundaries:
    - 不知道或没有依据时明确承认。
skills: []
actionTools: []
feedbackTools: []
```

第三方预设插件通过 `ctx.yokai.registerPresetSource()` 注册来源，并使用返回句柄的 `publish()`
发布 JSON 候选。主体统一完成 Schema 解码、引用校验、提示编译和 SHA-256；更新成功时发出
`yokai/preset-updated`。来源卸载后保留最后有效快照并标记离线，旧句柄不能继续发布。
