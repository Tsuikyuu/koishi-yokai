# Yokai 角色响应协议

状态：YK-020 Draft 0.1

本文固定 Yokai 版本 1 角色 XML、ActionTool 模板和本地验证边界。它只描述最终模型文本；
需要模型观察结果的 FeedbackTool 继续使用 adapter 的通用函数调用协议。

## 1. 文档结构

模型必须返回一个且仅一个 XML 文档。根元素的子元素顺序固定为 decision、可选 directives、
可选 actions：

```xml
<yokai-response version="1">
  <decision action="reply" reply-to="visible-message-id">
    <message>角色消息</message>
  </decision>
  <directives>
    <engagement action="extend"></engagement>
  </directives>
</yokai-response>
```

示例省略可选 actions；actions 出现时只能包含当前回合可见 ActionTool 的精确模板实例。协议示例
不得用 XML comment 充当占位符，因为 comment 本身会被解析器拒绝。

根元素前后只允许 XML whitespace，不接受 XML declaration、Markdown 围栏、说明文字、namespace、
注释、CDATA、processing instruction、DTD 或自闭合标签。属性只使用双引号。

## 2. Decision 与 directive

decision 是封闭集合：

- `silence` 不含 message；
- `react`、`reply`、`follow-up`、`initiate` 的 decision 必须各含一个且仅一个直接子级 message；
- 每个 decision 最多出现一个角色 message；ActionTool 参数元素即使同名也不属于角色 message；
- `reply-to` 仅允许出现在 `reply`，且必须命中宿主从冻结回合上下文提供的 message ID 白名单；
- message 经 XML entity 解码后必须非空、已 trim，且最长 4096 个 JavaScript code unit。

唯一内置 directive 是可选的 engagement 变更：

```xml
<directives><engagement action="extend"></engagement></directives>
<directives><engagement action="close"></engagement></directives>
```

缺席表示不改变租约。directives 出现时必须恰含一个 engagement，不能携带文本、额外属性或
未知子元素。租约状态更新由后续回合编排任务负责。

## 3. ActionTool 注册描述

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

`block-reply` 只允许用于 `before-send`，`wake` 只允许用于 `deferred`。XML 只能提供 tool ID 和
模板参数，不能提供或覆盖阶段、完成策略、失败策略、超时或 scope；这些值始终来自同一冻结注册快照。
回合 compiler 对冻结 scope 只运行一次 `isAvailable`，提示和 parser 共享过滤后的可见 Tool 集；parser
完成闭合 Schema 解码后才运行 `isInputAllowed`，拒绝或异常都会使整个信封失效且不泄漏参数。

## 4. 模板与输入映射

每份模板必须是唯一的 `<action tool="exact.id">...</action>`。根 Object 的 property 按 Schema
声明顺序映射为同名子元素；required property 恰好一次，optional property 可以省略。Object 递归
使用同一规则，Array 使用一个 property 容器和重复的 `<item>`：

```xml
<action tool="notebook.write">
  <notes>
    <item>
      <kind>fact</kind>
      <content>需要记住的内容</content>
    </item>
  </notes>
</action>
```

模板必须展示所有字段，Array 模板恰含一个 `<item>` 占位；`maxItems` 为 `0` 的 Array 因无法提供合法
占位模板而拒绝注册。运行时可按 `minItems`/`maxItems` 删除或重复 `<item>`，并按 Portable Schema
解码 String、StringEnum、Boolean、Integer、Number、Object 和 Array；未知、重复、乱序、
缺少 required、超出数组或数值边界、非法 enum 和额外属性都会使整份响应失效。`actions` 出现时至少
包含一个 Action，同一可见 Tool 可以在 actions 中出现多次。

## 5. 安全上限与原子验证

版本 1 固定以下解析和编译上限：

| 项目                        |   上限 |
| --------------------------- | -----: |
| XML UTF-8 字节数            | 16,384 |
| 元素深度                    |     16 |
| 元素数量                    |  1,024 |
| 属性数量                    |    128 |
| 单文本节点                  |  4,096 |
| 全文解码后文本              | 12,288 |
| 单回合 Action 数            |      8 |
| 可见 ActionTool 数          |     16 |
| 可见模板总 UTF-8 字节数     | 16,384 |
| 编译后协议提示 UTF-8 字节数 | 65,536 |

解析器只识别五个标准 named entity 和合法十进制/十六进制 numeric entity。有限 grammar 不解析
通用 DTD 或 entity，也不访问文件或网络。宿主先完成全部 decision、directive、Action、Schema、
reply target 和 scope 验证，再允许发送或执行任何内容；任一项失败都使整个信封失效，不能从残缺
文本降级提取 message 或 Action。公开的类型化错误不携带模型原文、模板文本或参数值。
compiler 还会对包含角色约束、Tool 描述、Schema 约束和模板的完整 system instruction 执行总字节
限制，避免合法但高基数的 enum 或 description 绕过单模板上限放大提示。

## 6. 提示与任务切片

编译后的 system instruction 固定角色内身份、禁语、不可信上下文边界、完整 XML 形状、可见 Tool
用途与输入约束，并逐项嵌入精确模板。当前消息、focus 消息、群聊消息和用户消息全部是不可信数据，
不能覆盖角色或协议指令。live WakeTurn 将 focus 注入带明确不可信标签的 JSON block，固定包含
`messageId`、`authorId`、`timestamp` 和 `content`；同一个 `messageId` 同时进入冻结回合的
`reply-to` 白名单。合法 `reply-to` 在 Koishi 边界发送为引用元素与纯文本消息；越权目标使回合保持
沉默。禁语包括 `context window`，模型不得声称尚未完成的异步动作已经成功。

YK-020 提供完整 ActionTool compiler/parser，但 ActionTool 的 prepare、执行和失败编排属于 YK-021。
在执行管线接入前，live WakeTurn 使用空 ActionTool 集；这样模型不会提出随后被宿主静默丢弃的动作。
