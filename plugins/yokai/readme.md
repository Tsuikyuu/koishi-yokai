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
