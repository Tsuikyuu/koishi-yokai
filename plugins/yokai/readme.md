# koishi-plugin-yokai

[![npm](https://img.shields.io/npm/v/koishi-plugin-yokai?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-yokai)

小妖怪

主插件需要 Koishi 数据库服务。`instanceId`（默认 `default`）隔离每个 Yokai 实例的
本地历史和状态；原始群聊消息默认保留 90 天，可通过 `messageRetentionDays` 调整。
消息编辑会追加版本并保留原始版本与前一版本关系，后台只按保留期清理超期记录；
MVP 不同步撤回或删除事件，也不提供消息级或手动删除入口。

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

当前最小响应协议只接受版本 1 的 `reply` 或 `silence` XML：合法 reply 最多发送一条纯文本
角色消息；模型不可用、adapter 失败或 XML 整体无效时保持沉默。首次生成前可加入
有界历史 ContextProvider；显式启用且 adapter 支持时，允许一批 `history.search` FeedbackTool
调用和唯一一次最终生成。该路径仍不启用记忆或 ActionTool，也不会自动切换模型。

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
