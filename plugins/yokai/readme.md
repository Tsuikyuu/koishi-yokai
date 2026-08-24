# @yokai/koishi-plugin-yokai

[![npm](https://img.shields.io/npm/v/@yokai/koishi-plugin-yokai?style=flat-square)](https://www.npmjs.com/package/@yokai/koishi-plugin-yokai)

小妖怪

主插件聚合所有已注册 adapter 的实时模型目录，并把模型投影到原生 Koishi 配置中的
单个 `model` 选项。adapter 刷新、卸载或重新注册后无需重载主插件；
模型在列表中统一显示为全小写的 `<adapterId>/<model>`，其中连续空白使用 `-` 代替；
当前已选但暂不可用的模型会保留为禁用选项，恢复后自动重新可用。

扩展可通过 `ctx.yokai.getModelCatalog()` 读取包含 revision 与 adapter 状态的完整快照，
并通过 `ctx.yokai.refreshModels()` 刷新全部 adapter，或传入 adapter ID 仅刷新一个实例。

群聊中直接 `@` Yokai 会冻结当前消息，并只通过已选中的通用 `YokaiAdapter` 发起一次
single-pass 生成。当前最小响应协议只接受版本 1 的 `reply` 或 `silence` XML：合法 reply
最多发送一条纯文本角色消息；未直接 `@`、模型不可用、adapter 失败或 XML 整体无效时保持沉默。
该路径不启用记忆、活跃度、ActionTool 或 FeedbackTool，也不会自动切换模型。
