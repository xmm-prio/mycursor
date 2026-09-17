# mycursor

给 Cursor 接入自有模型密钥（BYOK）的工具链。参考 `@cometix/ccursor` 的能力复刻，并在两处做了实质性加强：**保留 Cursor 官方原生工具**，以及**更稳定的网络劫持**（覆盖子代理与 SSH 远端）。

---

## 这是什么

Cursor 的模型请求发往 `api2.cursor.sh` 等官方端点。本工具在 Cursor 自己的 JS 包前面**前置一段注入载荷**，把其中与模型相关的请求改道到一个本地服务；本地服务把请求翻译成 OpenAI / Anthropic / Gemini 协议，用你自己的密钥调用，再把结果翻译回去。

与原工具最重要的差别有三点：

| | `@cometix/ccursor` | mycursor |
|---|---|---|
| 劫持层次 | 仅 `http.request` / `https.request`（HTTP/1.1） | HTTP/1.1、HTTP/2、`fetch`、`net`/`tls` socket、WebSocket、DNS 六层 |
| 让 HTTP/2 与 WebSocket 失效的手段 | 用 AST 改写 Cursor 的压缩包，逐版本重新定位 | 不改写任何表达式；WebSocket 由路由规则 + 运行时策略决定 |
| 服务未就绪时 | 在扩展 `activate` 里阻塞等待 30 秒 | 逐请求异步挂起；超时后**无损回落官方 API** |
| 未命中路由的请求 | 直通官方 | 由本地服务如实反代回官方，行为一致且只有一处路由权威 |
| 服务部署位置 | 塞进 Cursor 内置扩展目录，需**改掉扩展签名校验** | 独立进程，**不碰签名校验** |
| 原生工具 | 未作保证 | 以不变式强制：客户端声明的工具原样转发，服务端工具仅能补充不能覆盖 |
| Cursor 私有 protobuf schema | 把 1MB 的 `FileDescriptorProto` 打包进自己的扩展 | 安装时从**用户自己的 Cursor** 提取，本仓不含任何 Cursor 接口定义，版本永远对得上 |
| 模型注入 | 替换模型列表 | **追加**到官方列表，开启 BYOK 不会拿走用户本来就有的模型 |
| agent 回话的工具目录 | — | 从 schema **自动推导** 47 个原生工具（含参数 schema），Cursor 升级自动跟随 |
| 用户规则 / 技能 / 自定义子代理 | — | 一并转发：规则与技能进系统提示，子代理跑在用户为它选的模型上、只拿它声明的工具 |
| 知识库（"remember this"） | SQLite | 本地 JSON，用户可读可改可迁移；无账号时 add 不再假装成功 |
| Web 搜索 | 六个后端 | 同样六个后端；并以不变式保证**被客户端同名工具遮挡时，服务端实现连执行入口都不建立** |

---

## 快速开始

克隆后在仓库里执行：

```bash
git clone https://github.com/xmm-prio/mycursor.git
cd mycursor
npx . install
```

> **不要执行 `npx mycursor`。** 本项目尚未发布到 npm，而 npm 上的 `mycursor` 是**另一个毫不相干的包**（"Perfect for using custom cursors"）——那条命令会下载并运行别人的代码。发布时也需要换一个作用域名字。

`npx .` 会自己补齐依赖和构建产物：检测到 `packages/cli/dist` 不存在时先 `pnpm install` 再 `pnpm build`，然后才执行命令，所以全新克隆也是一条命令。已经构建过则直接跳过。

install 依次完成：给本机所有 Cursor 安装打补丁（含 `~/.cursor-server` 远端）→ 从你自己的 Cursor 提取 protobuf schema → 把配置面板打包成 VSIX 并用 Cursor 官方 CLI 装上 → 写好默认配置。

然后：

1. **重启 Cursor**（服务由扩展随窗口自动拉起）
2. 点开活动栏的 **MyCursor** 图标
3. 添加 provider、贴上密钥、按 **↓ Fetch** 拉模型、**Save**

配置好的模型随即出现在 Cursor 的模型选择器里。界面细节见 [配置面板.md](docs/配置面板.md)。

随时查看状态与排查：

```bash
npx . status      # 配置、provider、schema、服务、补丁状态
npx . doctor      # 逐目标明细、路由表、校验和审计
npx . schema      # 重新提取协议 schema（Cursor 升级后需要）
npx . extension   # 单独重装配置面板
npx . serve       # 在终端里手动跑服务
npx . uninstall   # 逐字节还原并移除面板
```

安装是幂等的：重复执行只会补齐缺失部分；任何一步失败都会**整体回滚**，不会留下"一半进程被改道"的状态。Cursor 升级后重新执行 `install` 即可（重打补丁 + 重新提取 schema + 重装面板）。

> 从仓库直接运行也可以：`pnpm install && pnpm build`，之后 `node packages/cli/dist/main.js <命令>`。`npx` 入口在依赖或产物缺失时会自动补上。

---

## 工程结构

按层分包，依赖只从上往下：

```
packages/
├── core/         纯领域层：配置模型、路由表、原生工具策略、自签证书、协议多路复用
├── protocol/     Cursor 线协议：结构化 protobuf 编解码、Connect/gRPC 帧、方法注册表
├── interceptor/  注入运行时：六层劫持 + 就绪门控 + 上行解析；构建出两份可注入载荷
├── patcher/      安装器内核：安装发现、内容指纹定位、备份、校验和、计划/应用/回滚
├── providers/    OpenAI / Anthropic / Gemini 适配器 + provider 注册表
├── server/       本地 BYOK 服务：控制端点、RPC 分发、上游反代、知识库、网络搜索、OpenAI 兼容入口
├── cli/          mycursor 命令行
└── extension/    Cursor 扩展：侧边栏配置面板 + 服务生命周期，不含劫持逻辑
```

设计文档见 [`docs/`](docs/)：

- [架构设计.md](docs/架构设计.md) — 分层、数据流、关键取舍
- [配置面板.md](docs/配置面板.md) — npx 安装、面板界面、字段到 Cursor 字段的映射
- [网络劫持.md](docs/网络劫持.md) — 六层劫持的原理、为什么需要每一层
- [schema恢复.md](docs/schema恢复.md) — 如何从用户自己的 Cursor 里恢复私有 protobuf schema
- [agent回话.md](docs/agent回话.md) — 接管原生聊天：会话汇合、工具目录推导、双向翻译
- [网络搜索.md](docs/网络搜索.md) — 服务端工具为什么要自己执行、六个后端、不遮挡原生工具
- [远端与子代理.md](docs/远端与子代理.md) — agent-host 与 SSH remote 的处理方式
- [原生工具保留.md](docs/原生工具保留.md) — 不变式如何定义与验证
- [验证报告.md](docs/验证报告.md) — 九套验证的实测结果
- [范围与局限.md](docs/范围与局限.md) — 哪些做到了、哪些没有、为什么

---

## 验证

九套验证互相独立，各自隔离一半变量，**全部不触碰你正在用的 Cursor**（只读，从不写入）：

```bash
pnpm test                # 108 项单元测试：路由、配置、工具策略、线协议、编解码、提取器、工具目录、载荷
pnpm verify:interceptor  # 26 项：六种客户端形态 × 命中/未命中 × 服务在/不在
pnpm verify:sandbox      # 43 项：桌面版 + SSH remote headless 版影子副本，打补丁与逐字节还原
pnpm verify:e2e          # 13 项：真实载荷 + 真实服务 + mock 官方 API + mock provider
pnpm verify:models       # 13 项：真实 schema 提取 + 编解码往返 + 模型注入 + 官方模型保留
pnpm verify:agent        # 62 项：原生 agent 回话，47 工具目录 + MCP + 规则/技能/子代理模型
pnpm verify:knowledge    # 23 项："remember this" 的本地增删改查与跨重启持久化
pnpm verify:websearch    # 38 项：六个搜索后端的真实请求、回合内执行、不遮挡原生工具
pnpm verify:panel        # 42 项：桩化 vscode 激活真实扩展包，面板表单与存盘往返
pnpm verify              # 以上全部（368 项）
pnpm clean               # 清掉构建产物与验证残留（沙箱影子约 100 MiB）
```

沙箱验证会把真实 Cursor 的补丁目标文件复制到 `.verify-out/sandbox/`，通过 `MYCURSOR_CURSOR_ROOT` 把安装器指向副本，`MYCURSOR_HOME` 把配置指向临时目录——实机安装全程不被写入。

---

## 配置

配置目录默认 `~/.mycursor/`（可用 `MYCURSOR_HOME` 覆盖）：

| 文件 | 作用 |
|---|---|
| `config.json` | 路由表、劫持分层开关、就绪策略、上游策略、工具策略 |
| `providers.json` | provider 与模型定义，含 API 密钥 |
| `cursor-descriptors.json` | 从你的 Cursor 提取的 protobuf schema（约 2.6 MB），由 `mycursor schema` 生成 |
| `install-manifest.json` | 安装清单，记录改过哪些文件 |
| `listener.{key,cert}.pem` | 本地 TLS 监听用的自签证书，首次启动时生成 |

`config.json` 支持**热更新**：保存即生效，无需重启 Cursor。编辑过程中文件短暂不合法时，运行时会**保留上一个可用版本**而不是静默关闭劫持。

关键开关：

```jsonc
{
  "byokMode": true,              // 总开关，关掉后完全走原生
  "interception": {
    "layers": {                  // 可逐层关闭：某层在未来版本出问题时无需重打补丁
      "http1": true, "http2": true, "fetch": true,
      "socket": true, "websocket": true, "dns": false
    },
    "readiness": {
      "strategy": "hold",        // hold=挂起等服务；passthrough=直接走官方
      "maxWaitMs": 20000
    },
    "websocketPolicy": "downgrade"  // downgrade=拒绝升级让客户端回落 SSE
  },
  "upstream": { "policy": "proxy" },  // 未命中路由的请求反代回官方
  "tools": {
    "preserveNative": true,      // 原生工具原样转发
    "allowAugmentation": true    // 服务端工具仅在不冲突时追加
  }
}
```

---

## 环境变量

| 变量 | 作用 |
|---|---|
| `MYCURSOR_HOME` | 覆盖配置目录 |
| `MYCURSOR_CURSOR_ROOT` | 把安装器指向某一个具体的 Cursor 安装目录 |
| `MYCURSOR_CURSOR_SERVER_HOME` | 覆盖 `~/.cursor-server`（SSH remote 的 headless 安装位置） |
| `MYCURSOR_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

---

## 许可

AGPL-3.0-or-later，与被参考的原工具一致。
