# Cursor 协议 schema 的恢复

## 一、问题

Cursor 的模型与 agent 端点走 ConnectRPC + protobuf，`.proto` 文件未公开。没有 schema 就只能做三件事：控制端点、纯 JSON 的 REST 桩、以及"空消息"应答（零字节是任何 protobuf 消息类型的合法编码）。真正的能力——把自己的模型注入模型选择器、接管 agent 回话——都需要知道字段号。

猜字段号是不可接受的：猜错会产生客户端**误解析**的回复，表现为模型列表空白或聊天异常，比"请求被转发"难排查得多。

## 二、Cursor 自己的包里就有完整 schema

Cursor 用 `@bufbuild/protobuf` 做代码生成。它的 v1 代码生成器把每个消息编成一张字段表、每个枚举编成一张值表、每个服务编成一个方法签名对象：

```js
// 消息
loe = e.makeMessageType("aiserver.v1.AvailableModelsResponse", () => [
  { no: 2, name: "models", kind: "message", T: Toe, repeated: !0 },
  { no: 1, name: "model_names", kind: "scalar", T: 9, repeated: !0 },
  { no: 16, name: "subagent_model_configs", kind: "map", K: 9, V: { kind: "message", T: ln } },
])

// 枚举
doe = e.makeEnum("aiserver.v1.AvailableModelsResponse.DegradationStatus", [
  { no: 0, name: "DEGRADATION_STATUS_UNSPECIFIED", localName: "UNSPECIFIED" },
])

// 服务
nO = { typeName: "aiserver.v1.AiService", methods: {
  availableModels: { name: "AvailableModels", I: Req, O: Res, kind: o.Unary },
}}
```

这些结构在 Cursor 3.14.7 的包里有 **23,628 个消息站点、1,942 个枚举站点、300 个服务站点**。也就是说，完整 schema 一直就在用户自己的安装目录里。

## 三、从用户自己的安装里读，而不是打包进本仓

被参考的 `@cometix/ccursor` 选择把 schema 打包进自己的扩展——它内嵌了 base64 编码的 `FileDescriptorProto`，其中 `aiserver_v1.proto` 有 135 万个 base64 字符（约 1MB），另有 `agent_v1.proto`、`anyrun_v1.proto` 等共 11 份。

本工具选择在安装时从用户的 Cursor 里提取。理由有三条：

1. **不转发别人的专有 schema。** 本仓不含 Cursor 的任何接口定义。
2. **版本永远对得上。** 描述符来自用户实际安装的那个版本，不存在"工具带的 schema 比 Cursor 旧"的错配。
3. **Cursor 升级由重新提取解决，而不是由本仓发版解决。** `mycursor install` 会同时重打补丁和重新提取。

## 四、提取的实现

`packages/patcher/src/schema/` 两个文件：

- `bundle-scanner.ts` 是一个只认代码生成器那点语法的迷你读取器：对象/数组字面量、数字、字符串、压缩后的 `!0`/`!1` 布尔、裸标识符（类型引用）、`ns.getEnumType(VAR)` 调用。**不做任何求值。**
- `extract-descriptors.ts` 从已知偏移出发定位每个站点、取平衡括号区间、交给读取器解析。

用整套 JavaScript 解析器去解 38MB 的包只为读几千个小字面量是不划算的；从站点出发使提取耗时与 **schema 规模**成正比而非与**包体积**成正比。实测在 5 个包（共约 97MB）上耗时 **1.2 秒 / 峰值 228 MiB**。

### 读不懂的输入必须拒绝，不能空转

读取器靠文本启发式定位，所以它**一定会**被指到不是字段表的地方——Cursor 换个代码生成形式就够了。这类站点由调用方 `try/catch` 跳过，代价很小；真正危险的是读取器**不报错也不前进**。

这个坑是实际踩到的：有用户在 **Cursor 3.19.19** 上执行 `mycursor schema`，跑了 33 秒后以 4GB 堆溢出崩溃。原因是 `parseValue` 遇到没有规则的字符时返回的 `end` 等于入参 `index`，而 `parseArray` 不检查游标是否前进——于是无限循环往数组里塞 `{ref:''}`，直到堆耗尽。**19 个字符的输入 `[{no:1,name:"a"},)]` 就能复现。**

三道边界，现在都有单元测试盯着：

| 边界 | 取值依据 |
|---|---|
| 遇到无规则的字符**抛错**而非返回原位 | 这是根因；空转比拒绝糟糕得多 |
| 数组/对象循环断言游标必须前进 | 兜底任何将来新增的返回路径 |
| 单个字面量跨度上限 256 KiB | 实测 3.14.7 的 11,847 张字段表：中位数 98 字符、最大 6,107；上限是实测最大值的约 40 倍 |
| 嵌套深度上限 32 | 失锚区域不会被解析成庞大的对象树 |

跨度上限同时解决时间问题：失锚的开括号原先会被拿去和几十 MB 外的闭括号配对，让每个坏站点都付出一次全包扫描。

### 部分提取会被明说

比"提取失败"更麻烦的是**提取了一半**：文件照写、命令报成功，而依赖缺失类型的功能悄悄退回转发，表现成"BYOK 不管用"却没有任何线索。所以 `mycursor schema` 末尾按功能逐项报告，缺了就列出缺哪些类型：

```
  ok models in the picker
  ok native agent chat
  ok MCP tool forwarding
  ok knowledge base
```

### 两种代码生成形式都要认

`@bufbuild/protobuf` 对 Cursor 自己的消息用 `makeMessageType`，但对**它自带的 well-known 类型**（`Timestamp`、`Duration`、`Struct`、`Value`）用的是类静态成员：

```js
Rm.typeName = "google.protobuf.Timestamp";
Rm.fields = e.util.newFieldList(() => [{ no: 1, name: "seconds", kind: "scalar", T: 3 }, …]);
var y = Rm;          // 别的模块引用的是这个别名
```

只认第一种形式时，**所有引用 well-known 类型的字段都解析不出来**——包括 `agent.v1.McpArgs.args` 的 `map<string, google.protobuf.Value>`，也就是 MCP 工具参数根本没法编码。

补上第二种形式并跟一跳变量别名（`var y = Rm`）之后：

| | 之前 | 之后 |
|---|---|---|
| 消息数 | 5,381 | 6,184 |
| 未解析引用 | 239 | 95 |
| `McpArgs.args` | `map<string, ?>` | `map<string, google.protobuf.Value>` |

剩下的 95 个未解析引用会安全降级为不透明字节并无损往返。

### 一个必须踩过才知道的坑：按包内解析，不能跨包合并变量表

字段表里的类型引用指向压缩后的变量（`T: Toe`），所以提取必须两遍：先把变量绑定到类型名，再解析引用。

**每个包是独立压缩的**，所以同一个短标识符在不同包里指向不同类型——`ln` 在渲染进程里是一个消息，在 agent host 里是另一个。最初的实现把 5 个包的变量表合并后再解析，结果 8 个字段被解析到了**错误的类型**上：

```
agent.v1.RequestContextRulesPart#1 (rules)
  解析为 aiserver.v1.StreamChatContextResponse.ChunkIdentity
  实际是 agent.v1.CursorRule
```

这类错误不会让程序崩溃，只会产出客户端误解析的回复。修法是在每个包内部完成解析，再合并**已解析**的描述符。

## 五、交叉校验：18,279 个字段

提取结果需要独立来源来验证。`ccursor` 内嵌的 base64 `FileDescriptorProto` 正好是**同一 schema 的另一种编码**——protobuf 自己的规范编码。用本工具的结构化读取器解码它，再逐字段对比：

```
compared 4945 messages / 18279 fields against the reference
reference-only fields numbered above ours (version skew): 256
4 disagreement(s):
  aiserver.v1.WaterfallSpan#3 (start_time): kind message vs scalar
  aiserver.v1.WaterfallSpanEnd#1 (timestamp): kind message vs scalar
  aiserver.v1.WaterfallSpanLog#1 (timestamp): kind message vs scalar
  aiserver.v1.WaterfallSpanStatus#1 (timestamp): kind message vs scalar
```

**18,279 个共有字段，在字段号、名称、种类、标量类型、repeated 与类型名上零处不一致。**

- 256 个"仅参考端有、且字段号高于我方全部字段"的条目是版本差异：ccursor 内嵌的 schema 来自比 3.14.7 更新的 Cursor（例如 `AvailableModelsRequest#14 byok_enabled`、`ConversationMessage#98 agent_mode`）。
- 剩下 4 处是同一类：这 4 个字段在我方是**未解析引用**（指向 `google.protobuf.Timestamp`，跨模块别名导致绑定不到），在更新版本里已改成标量。未解析引用会安全降级为不透明字节。

这次校验依赖下载 ccursor，因此不进发布验证套件，结果记录在 [验证报告.md](验证报告.md)。

## 六、描述符驱动的编解码

`packages/protocol/src/schema/message-codec.ts` 把 protobuf 字节与以 camelCase 为键的普通 JS 对象互转。两条属性对真实客户端的正确性是决定性的：

**未知字段必须往返不丢。** 描述符没描述的字段以原始线数据保留并在重编码时原样写回。没有这条，"解码请求 → 改一个字段 → 重编码" 会静默丢掉其余全部内容，转发被修改的请求就会损坏它。单元测试对此有显式断言，包括"类型缺失的嵌套消息重编码后逐字节相同"。

**packed 与非 packed 的 repeated 标量都要接受。** proto3 默认打包数值标量，但合规编码器也可以不打包；只认一种形式的解码器会读错另一种。

64 位整数以字符串传递（与 protobuf JSON 的选择一致），避免在 JavaScript 里丢精度。枚举以数字传递，因为 proto3 要求未知枚举值必须保留。

## 七、当前用到的地方

### 模型注入（已完成并实测）

`aiserver.v1.AiService/AvailableModels` 由本地服务应答：

1. 先取官方响应（用提取到的描述符解码）
2. 把本地配置的模型**追加**进去，而不是替换
3. 重新编码返回

"追加而非替换"是有意的：开启 BYOK 不应该拿走用户本来就有的模型。端到端验证断言了 4 个模型同时在场（2 个官方 + 2 个本地），且官方响应的其他字段（`useModelParameters`、各模型的 `defaultOn`）在解码/重编码后保持不变。

没有描述符时，服务原样转发官方响应并在状态里报告 `schema.available = false`——绝不用猜出来的字段号作答。

### agent 回话（消息形状已摸清，循环待实现）

提取结果已经说清了协议：

```
agent.v1.AgentService/RunSSE     server-stream  aiserver.v1.BidiRequestId -> agent.v1.AgentServerMessage
agent.v1.AgentService/Run        bidi           agent.v1.AgentClientMessage -> agent.v1.AgentServerMessage
aiserver.v1.BidiService/BidiAppend  unary       aiserver.v1.BidiAppendRequest -> aiserver.v1.BidiAppendResponse

aiserver.v1.BidiAppendRequest
  #1 data          string
  #2 request_id    aiserver.v1.BidiRequestId
  #3 append_seqno  int64
  #4 data_binary   bytes        ← AgentClientMessage 序列化在这里

agent.v1.AgentClientMessage  (oneof message)
  #1 run_request / #4 conversation_action / #6 interaction_response / ...

agent.v1.AgentServerMessage  (oneof message)
  #1 interaction_update / #3 conversation_checkpoint_update / #7 interaction_query / ...
```

`RunSSE` 的请求只带一个 request id，真正的运行请求从 `BidiAppend` 过来——这印证了 `packages/server/src/agent/session.ts` 里按 request id 做汇合点的设计。剩下的工作是 `InteractionUpdate` 子树与 provider 事件流的对接，见 [范围与局限.md](范围与局限.md)。

## 八、使用

```bash
mycursor schema              # 提取（install 会自动执行）
mycursor schema --force      # 强制重新提取
mycursor schema --dry-run    # 只报告不写入
mycursor doctor              # 查看已加载的 schema 规模
```

描述符写到 `~/.mycursor/cursor-descriptors.json`（约 2.6 MB）。服务在需要 schema 的请求到来时按修改时间检查并热加载，因此重新提取后不必重启服务。
