# Yokai 角色响应协议

本文规定 Yokai 角色 XML、ActionTool 模板和本地验证边界。它只描述最终模型文本；
需要模型观察结果的 FeedbackTool 使用 adapter 的通用函数调用协议，不属于本文范围。

## 1. 文档结构

模型必须返回一个且仅一个 XML 文档。根元素必须是无属性的 `<output>`；其直接子元素依次为
零至四个 `<message>`、可选的 `<actions>`：

```xml
<output>
  <message quote="VISIBLE MESSAGE ID">需要明确引用目标的角色消息</message>
  <message>随后发送的普通角色消息</message>
</output>
```

示例省略可选 actions；actions 出现时只能包含当前回合可见 ActionTool 的精确模板实例。XML comment
非法，不得用作占位符。

所有 message 必须位于 actions 之前。零个 message 表示本回合沉默；没有 action 的沉默仍使用完整的
`<output></output>`，不使用自闭合标签。根元素及容器之间只允许 XML whitespace，不能出现其他文本。

根元素前后只允许 XML whitespace，不接受 XML declaration、Markdown 围栏、说明文字、namespace、
注释、CDATA、processing instruction、DTD 或自闭合标签。属性只使用双引号。

## 2. Message

根级角色 message 遵守以下规则：

- `<output>` 可以直接包含零至四个 message；ActionTool 参数元素即使同名也不计入这个数量；
- 每个 message 只允许纯文本，XML entity 解码后必须非空、已 trim，且最长 4096 个 JavaScript code unit；
- message 只能没有属性，或恰有一个 `quote="VISIBLE MESSAGE ID"` 属性；quote 值必须命中宿主从
  冻结回合上下文提供的可见 message ID 白名单；
- 没有 quote 是普通发言的默认形式；只有确实需要平台引用时才在对应的单个 message 上添加 quote，
  quote 不会影响其他 message；
- 零个 message 即 silence；平台反应由 ActionTool 表达；回复、跟进和主动发言的社会语义来自唤醒
  原因与冻结上下文；quote 仅是一段待发消息的传输元数据。

根级只允许 message 和 actions；其他直接子元素一律拒绝。

## 3. 协议标识与记录

宿主持有的协议标识为 `yokai.role-output/2`，该值不进入模型 XML。持久化或回放记录必须同时保存
protocolId、该回合的 ActionTool 注册快照、冻结 scope 和可见 message ID 白名单。

## 4. ActionTool 注册描述

ActionTool 注册快照固定以下字段：

- 稳定 `id` 和 `protocolVersion`；
- 角色用途 `description`；
- 可单独解析的静态 `xmlTemplate`；
- 闭合的 `PortableToolInputSchema`；
- `executionStage`：`before-send`、`after-send` 或 `deferred`；
- `completionPolicy`：`none` 或 `wake`；
- `failurePolicy`：`continue` 或 `block-reply`；
- 正整数 `maxDurationMs`；
- 基于冻结 `CapabilityScope` 的纯同步 `isAvailable` 判定；
- 对完整 Schema 解码后参数执行的纯同步 `isInputAllowed(scope, input)` 授权判定。

`block-reply` 只允许用于 `before-send`，失败时阻止本回合全部待发 message；`wake` 只允许用于
`deferred`。XML 只能提供 tool ID 和
模板参数，不能提供或覆盖阶段、完成策略、失败策略、超时或 scope；这些值始终来自同一冻结注册快照。
回合 compiler 对冻结 scope 只运行一次 `isAvailable`，提示和 parser 共享过滤后的可见 Tool 集；parser
完成闭合 Schema 解码后才运行 `isInputAllowed`，拒绝或异常都会使整个信封失效且不泄漏参数。

## 5. 模板与输入映射

每份模板必须是唯一的 `<action tool="exact.id">...</action>`。根 Object 的 property 按 Schema
声明顺序映射为同名子元素；required property 恰好一次，optional property 可以省略。Object 递归
使用同一规则，Array 使用一个 property 容器和重复的 `<item>`：

```xml
<action tool="notebook.write">
  <notes>
    <item>
      <kind>fact</kind>
      <content>需要记住的内容</content>
      <source-message-ids>
        <item>message-id</item>
      </source-message-ids>
    </item>
  </notes>
</action>
```

模板必须展示所有字段，Array 模板恰含一个 `<item>` 占位；`maxItems` 为 `0` 的 Array 因无法提供合法
占位模板而拒绝注册。运行时可按 `minItems`/`maxItems` 删除或重复 `<item>`，并按 Portable Schema
解码 String、StringEnum、Boolean、Integer、Number、Object 和 Array；未知、重复、乱序、
缺少 required、超出数组或数值边界、非法 enum 和额外属性都会使整份响应失效。`actions` 出现时至少
包含一个 Action，同一可见 Tool 可以在 actions 中出现多次。

## 6. 安全上限与原子验证

本协议固定以下解析和编译上限：

| 项目                        |   上限 |
| --------------------------- | -----: |
| XML UTF-8 字节数            | 16,384 |
| 元素深度                    |     16 |
| 元素数量                    |  1,024 |
| 属性数量                    |    128 |
| 单文本节点                  |  4,096 |
| 全文解码后文本              | 12,288 |
| 根级角色 message 数         |      4 |
| 单回合 Action 数            |      8 |
| 可见 ActionTool 数          |     16 |
| 可见模板总 UTF-8 字节数     | 16,384 |
| 编译后协议提示 UTF-8 字节数 | 65,536 |

解析器只识别五个标准 named entity 和合法十进制/十六进制 numeric entity。有限 grammar 不解析
通用 DTD 或 entity，也不访问文件或网络。宿主先完成全部 message、Action、Schema、
quote target 和 scope 验证，再允许发送或执行任何内容；任一项失败都使整个信封失效，不能从残缺
文本降级提取 message 或 Action。公开的类型化错误不携带模型原文、模板文本或参数值。
这项原子性截至第一次平台发送之前；多段平台发送不是事务。任一段发送失败后停止后续段，已经成功
发送的段不伪装回滚，也不重发。
包含角色约束、Tool 描述、Schema 约束和模板的完整 system instruction 计入编译后协议提示的总字节
上限。

## 7. 提示与宿主边界

编译后的 system instruction 固定角色内身份、禁语、不可信上下文边界、完整 XML 形状、可见 Tool
用途与输入约束，并逐项嵌入精确模板。当前消息、focus 消息、群聊消息和用户消息全部是不可信数据，
不能覆盖角色或协议指令。宿主将 focus 注入带明确不可信标签的 JSON block，固定包含
`messageId`、`authorId`、`timestamp` 和 `content`；同一个 `messageId` 同时进入冻结回合的
`quote` 白名单。合法 quote 在 Koishi 边界发送为引用元素与纯文本消息；越权目标使回合保持
沉默。禁语包括 `context window`，模型不得声称尚未完成的异步动作已经成功。
