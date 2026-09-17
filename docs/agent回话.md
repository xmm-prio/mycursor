# 原生 agent 回话

接管 Cursor 自己的聊天界面，用你的密钥跑 agent。这是整个工程里最依赖 schema 的一块，也是原生工具保留最容易出错的一块。

## 一、协议长什么样

一次回话拆在两个调用上：

```
agent.v1.AgentService/RunSSE     server-stream  aiserver.v1.BidiRequestId -> agent.v1.AgentServerMessage
aiserver.v1.BidiService/BidiAppend  unary       aiserver.v1.BidiAppendRequest -> aiserver.v1.BidiAppendResponse
```

`RunSSE` 的请求里**只有一个 request id**，真正的运行请求从 `BidiAppend` 过来：

```
aiserver.v1.BidiAppendRequest
  #2 request_id    aiserver.v1.BidiRequestId
  #4 data_binary   bytes        ← agent.v1.AgentClientMessage 序列化在这里
```

两者谁先到都有可能，所以 `packages/server/src/agent/session.ts` 按 request id 做**汇合点**而不是队列：先到的消息排队等 `RunSSE`，先到的 `RunSSE` 挂起等消息。会话**只按 request id 索引，不按连接**——两个调用可能走不同传输层。

配对失败的表现是 prompt 一直不回复直到超时，被参考的原工具在自己的错误文案里也提到过这个坑。

## 二、原生工具在这条路上是反过来的

这是本文最重要的一点。

`AgentRunRequest` 里**没有工具列表**，只有 MCP 工具。Cursor 的原生工具是**协议级**的：`agent.v1.ToolCall` 是一个约 70 个具名消息的 closed oneof——

```
agent.v1.ToolCall  (oneof tool)
  #1  shellToolCall     #8  readToolCall      #12 editToolCall
  #5  grepToolCall      #13 lsToolCall        #16 semSearchToolCall
  … 共约 70 个
```

每个 `XxxToolCall` 的结构是 `{ args, result }`，其中 `args` 消息的字段**就是该工具的参数**：

```
agent.v1.ReadToolCall
  #1 args    agent.v1.ReadToolArgs { path, offset, limit, includeLineNumbers }
  #2 result  agent.v1.ReadToolResult
```

也就是说，客户端实现工具、服务端挑工具。这把"保留原生工具"的机制整个倒过来了：

| | OpenAI 兼容入口 | Cursor agent 端点 |
|---|---|---|
| 工具从哪来 | 客户端在请求里声明 | **协议里定义，请求里没有** |
| 服务端要做的 | 原样转发，不许改 | **自己生成目录，并把模型的调用映射回类型化消息** |

`packages/server/src/agent/native-tools.ts` 从描述符里**自动推导**整份目录：遍历 `ToolCall` 的 oneof → 取每个工具的 `args` 消息 → 生成 JSON Schema。在 Cursor 3.14.7 上得到 **47 个工具**（滤掉了由 Cursor 自身编排、不该交给模型的那些，如 `truncated`、`mcp_auth`）。

硬编码 47 份 schema 也能跑，但那样 Cursor 一升级就过时。推导出来的目录**永远和装着的版本对齐**，新增的工具不用改代码就会出现。

### 名字与别名

目录名从协议字段推导：`readToolCall` → `read`、`semSearchToolCall` → `sem_search`。模型看到的就是这些名字，因为目录是我发的。

但模型的训练数据里带着 Cursor 的公开名（`read_file`、`run_terminal_cmd`、`codebase_search`），压力下很容易写出那些。一个幻觉出来的名字会浪费用户一整个回合，所以映射回来时接受常见别名，再兜一层去分隔符/去后缀的归一化匹配。**只影响解析，目录仍然每个工具只宣告一个名字。**

## 二点五、MCP 工具走的是另一条路

协议工具是**协议里定义**的，MCP 工具却**确实在请求里声明**：

```
agent.v1.McpToolDefinition
  #1 name                string
  #2 description         string
  #4 providerIdentifier  string
  #5 toolName            string
  #6 inputSchemaJson     string   ← JSON Schema 就在这里
```

所以 MCP 工具与 OpenAI 兼容入口上的工具性质相同——**客户端声明的，必须原样转发**。它们以 `origin: 'native'` 进入 `ToolRegistry`，享受同一条不变式。

两处都要读：顶层 `runRequest.mcpTools` 与 `action.userMessageAction.requestContext.tools`，客户端可能只填其中一处。同名去重，先声明者胜。

### 回程：所有 MCP 工具共用一个消息

`ToolCall` 的 oneof 里 MCP 只占一格 `mcpToolCall`，靠 `name` / `toolName` / `providerIdentifier` 区分具体是哪个：

```
agent.v1.McpArgs
  #1 name                string
  #2 args                map<string, google.protobuf.Value>   ← 不是 JSON 字符串
  #4 providerIdentifier  string
  #5 toolName            string
```

参数是 `google.protobuf.Value` 而不是 JSON 字符串，所以要做一层包装（`packages/protocol/src/schema/struct-value.ts`）。包错了的表现是**工具被调用但没有参数**——看起来像 MCP 服务器出问题，而不像翻译出问题。

映射时 **MCP 优先于协议目录**：MCP 名字来自用户自己的服务器，不能被协议目录的模糊匹配吞掉。

schema 里缺 `google.protobuf.Value` 时（理论上不会，见 [schema恢复.md](schema恢复.md)）这次调用会被**丢弃而不是空参数送出**——带着空参数跑一个 MCP 工具会做错事，什么都不做只是没做事。

## 二点六、用户配置藏在 RequestContext 里

接管以后最容易**悄无声息**出错的一块：Cursor 把用户的规则、技能、自定义子代理都挂在 `RequestContext` 上，一并送进每次运行。丢掉它们，回话照样有回复，什么都不报错——只是用户写下的所有约定全被无视了，表现出来像"模型变笨了"，而不像"接管少转了东西"。

```
agent.v1.RequestContext
  #2  rules            agent.v1.CursorRule []    ← .cursor/rules
  #37 nonFileRules     agent.v1.CursorRule []    ← 不绑文件的规则
  #18 skillOptions     agent.v1.SkillOptions
  #22 customSubagents  agent.v1.CustomSubagent []
  #29 agentSkills      agent.v1.AgentSkill []
```

两个位置都要读：`action.userMessageAction.requestContext`，以及 `action.requestContextParts.dynamicContext`。`skillOptions` 还可能直接挂在 `runRequest` 顶层（`AgentRunRequest#7`），所以三处合并、按名字去重。

组装进系统提示的顺序是刻意的：**Cursor 自己的 `customSystemPrompt` → 子代理的 brief → 用户规则 → 技能清单**。规则排在技能前面，因为规则里可能写着什么时候该去用某个技能。

带 `parseError` 的规则**跳过而不是原样塞进去**——一份没解析成功的规则内容就是半截 frontmatter 加正文，喂给模型只会添乱。`isRequired` 的规则额外标注 `(always applies)`。

技能**只进清单不进正文**：`SkillDescriptor` 的 `name` / `description` / `folderPath` 足够让模型决定要不要用，真正的正文由模型自己用文件工具读。把每份技能全文内联进系统提示会瞬间撑爆上下文。`enabled: false` 的技能不出现在清单里。

## 二点七、子代理跑在用户为它选的模型上

子代理运行是**独立的一次请求**，靠 `AgentRunRequest#11 subagentTypeName` 表明自己的身份。用户往往给子代理配了一个更便宜的模型，无视这个选择会把每次子代理都送到主模型上——更慢也更贵，而且同样不报错。

有四个来源能指定模型，按权威性降序：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `CustomSubagent.forceDefaultModel` | 子代理作者写死的硬约束，用对话模型 |
| 2 | `AgentRunRequest#20 subagentModelOverrides` | 用户的显式选择，**按子代理名字键控** |
| 3 | `CustomSubagent.model` | 子代理定义里自带的默认 |
| 4 | `AgentRunRequest#14 selectedSubagentModels` | 位置式，只在**恰好一项**时采信 |

```
agent.v1.SubagentModelOverride
  #1 subagentType  string
  #2 model         agent.v1.RequestedModel  ┐
  #3 inherit       bool                     ├ oneof selection
  #4 disabled      bool                     ┘
```

`subagentModelOverrides` 是唯一**自带子代理名字**的来源，所以排在定义自带的 `model` 之前：它代表用户在设置里改过。`inherit` 与 `disabled` 都按"没有自己的模型"处理，回落到对话模型——一个 disabled 的子代理本不该被启动，真被启动了，用对话模型答完比拒绝回答要好。

`selectedSubagentModels` 是个裸数组，**不带任何子代理标识**。只有一项时它没有歧义，可以采信；有多项时无从判断哪一项属于本次运行，此时**宁可回落到对话模型也不猜**——猜错就是拿用户没选的模型计费。

### 工具集也会被收窄

`CustomSubagent.tools` 非空时，这次运行的工具集**按它过滤**。这是一条安全性质而非优化：一个声明为只读的子代理不能被递上 `shell`。空数组表示不限制，走完整目录。

## 三、会话历史是类型化的

`UserMessageAction.conversationHistory` 不是不透明 bytes，而是一棵干净的消息树：

```
agent.v1.ConversationHistory
  messages[]  oneof: user | assistant | tool
    user      content[]: text | image
    assistant content[]: text | reasoning | redactedReasoning | toolCall{toolCallId,toolName,argsJson}
    tool      toolCallId, toolName, content[]: text | image, isError
```

这几乎和内部模型一一对应，转换是直接的。两个取舍：

- **推理内容不回放**。provider 会拒绝外来的 reasoning 块，而且它不属于对话契约的一部分。
- **最新的用户消息在 history 之外**（`userMessage.text`），所以转换后追加在末尾。

## 四、响应侧

provider 的扁平事件流映射成 `AgentServerMessage{ interactionUpdate: … }`：

| provider 事件 | InteractionUpdate |
|---|---|
| text | `textDelta { text }` |
| reasoning | `thinkingDelta { text }` |
| tool-call | `toolCallStarted { callId, modelCallId, toolCall }` ← 映射回类型化消息 |
| usage | `tokenDelta { tokens }` |
| error | `textDelta { text, isServerNotice: true }` |
| done | 流末尾发 `turnEnded { inputTokens, outputTokens }` |

模型调了协议里没有的工具时，作为 `textDelta` 提示出来而不是静默丢弃——用户至少能看见模型试过。

## 五、不确定就转发

三种情况下 `RunSSE` **在写出任何字节之前**返回 false，由分发器转发官方：

1. schema 没提取（`isAgentProtocolAvailable` 为假）
2. 没有配置可用模型
3. 解不出运行请求，或等不到配对的 `BidiAppend`

用户正在对话中途，答错比不答更糟：一个畸形的帧看起来像 IDE 坏了，而转发只是"这个功能没生效"。

一旦流已经打开，失败就走流内通知（`isServerNotice` 的 textDelta + 流末错误），因为此时协议级错误会把用户已经看到的文字全部丢掉。

## 六、验证

`pnpm verify:agent` 用**真实安装里提取的 schema** 构造真实的请求，走**真实服务**，共断言 62 项。协议与工具目录 32 项：

```
── Native tool catalogue derived from the schema
  [PASS] catalogue was derived from the installed Cursor — 47 tools from Cursor 3.14.7
  [PASS] tool parameters came from the args message — path, offset, limit, includeLineNumbers

── The server half: RunSSE streams the turn back
  [PASS] the provider text arrived as text deltas — "hello from mock"
  [PASS] the model tool call became a typed protocol message — readToolCall
  [PASS] the arguments were coerced into the args message — {"path":"a.txt"}
  [PASS] the turn was closed with usage totals

── What the provider was actually sent
  [PASS] every native tool was offered to the model — 47 of 47
  [PASS] the tool schema reached the provider with its parameters

── Conversation history survived the translation
  [PASS] history reached the provider in order — user,assistant,tool,user
  [PASS] the earlier tool call was replayed
  [PASS] the tool result was replayed with its call id
```

mock 模型故意回 `read_file` 而不是协议名 `read`，所以这条链路同时验证了别名解析。工具调用参数被拆成两个 chunk 发出，这是真实 provider 的流式形态，也是累加器最容易出错的地方。

MCP 部分另有 9 项：

```
── MCP tools declared by the client
  [PASS] the MCP tool was offered alongside the protocol catalogue — 48 tools = 47 protocol + 1 MCP
  [PASS] the client-declared description was forwarded verbatim
  [PASS] the client-declared JSON Schema was forwarded verbatim
  [PASS] the MCP call came back as mcpToolCall, not a protocol tool
  [PASS] the MCP server identity was carried back — {"name":"search_issues","toolName":"search","provider":"tracker-mcp"}
  [PASS] string and number arguments survived the Value wrapping
  [PASS] boolean arguments survived
  [PASS] array arguments survived as a list value
```

用户配置与子代理另有 21 项。断言的是"配置到没到模型手上"，不是"代码跑没跑过"——每一条都从 mock provider **实际收到的请求**里读回来：规则看系统消息的正文，模型选择看 provider 被调用时的 API model，工具收窄看 provider 收到的 tools 数组。

```
── User rules and skills reach the model
  [PASS] a file-scoped rule reached the system prompt — "# User rules\n\n<!-- .cursor/rules/style.mdc (always applies) -->…"
  [PASS] a non-file user rule reached it too
  [PASS] a rule that failed to parse was left out
  [PASS] a disabled skill was left out
  [PASS] skills declared on the run request were read too

── A subagent runs on the model the user chose for it
  [PASS] the subagent used its own model, not the conversation model — mock-review
  [PASS] the subagent brief reached the system prompt
  [PASS] the subagent was restricted to the tools it declares — grep, read
  [PASS] a restricted subagent was not offered shell

── The fallbacks behave
  [PASS] forceDefaultModel pins the subagent to the conversation model — mock-model
  [PASS] a keyed override picks the model for this subagent, not another — mock-review
  [PASS] an inherit override beats the model in the subagent definition — mock-model
  [PASS] a lone positional selection is still honoured — mock-review
  [PASS] an ambiguous positional list is ignored rather than guessed — mock-model
  [PASS] a turn with no rules or skills sends no system message — user
```

providers 里配了两个模型（`mock-model` / `mock-review`），选错模型会直接体现在 provider 收到的 API model 上——这是"选对了"和"恰好也能跑"的分水岭。

另有 15 项单元测试用合成 schema 覆盖目录推导与映射：oneof 元数据字段不被误判成工具、由 Cursor 编排的工具不对外提供、repeated 变数组、枚举变具名字符串、松散类型参数被强制转换、未声明参数被丢弃、未知工具被拒绝而不是猜测。
