# prefix-sentinel

只读观测型 pi 扩展：**检查前缀有没有改变**。

启用后它代理（拦截观察）pi 发往推理框架的**每一次**请求——在 `before_provider_request`
钩子里拿到 pi-ai 刚构建好的 wire body（system、tools、messages、model…，即真正发出去
的全文），与上一次请求的全文做**全文 diff**，并把结果记入日志。发回给 Agent 的
**响应完全不经过本插件**（pi 直接把 provider 响应交给 Agent），请求本身也原样放行、
一个字节都不改。

打开它、正常使用一段时间，之后看 `log.jsonl` 就知道期间前缀是否被改过、改在哪里。

## 磁盘布局（`<项目>/.pi/prefix-sentinel/`）

| 文件 | 内容 |
|---|---|
| `last-request.json` | **只保留最新一份**发给框架的全文（pretty JSON，每次原子覆盖：临时文件 + rename） |
| `log.jsonl` | 每次请求一行：与上一份全文的**完整 diff** + 结构化前缀判定 |

这样磁盘上不会无限堆全文：任意时刻的"当前全文"就是 `last-request.json`，
历史变化全部由 `log.jsonl` 的逐轮 diff 还原。

## log.jsonl 每行字段

```jsonc
{
  "ts": 1758520000000,        // 请求时刻
  "process": 1758519000000,   // 本进程启动时刻（区分并发进程）
  "index": 12,                // 本进程内的请求序号
  "model": "anthropic/claude-…",
  "messages": 40,             // 本请求 messages 条数
  "tools": 9,                 // 本请求 tools 条数
  "prevIndex": 11,            // 对比的上一次请求序号
  "crossRestart": false,      // true = 与上一个进程的最后一次请求对比
  "classification": "append", // append | prefix-changed | rewind | branch
  "commonPrefixMessages": 11, // 两条请求的最长公共 messages 前缀长度
  "firstDivergentMessage": 11,// 首个不同的 message 下标（无则为 null）
  "toolsChanged": false,
  "systemChanged": false,
  "modelChanged": false,
  "changed": false,
  "diffOmittedContext": { "prefix": 94, "suffix": 12 }, // 被折叠为计数的未变上下文行数
  "diffBlockDumped": false,   // true = 变更区过大，用整块 -/+ 倾倒（仍然完整）
  "diffChars": 234,
  "diff": "  …94 unchanged lines …\n- …\n+ …"  // 完整变更区 diff
}
```

分类语义（上一条请求 → 本条请求的 messages 列表）：

| classification | 含义 | 前缀是否 intact |
|---|---|---|
| `append` | 旧 messages 逐条原样保留，只往后追加 | ✅ 是（KV 前缀可复用） |
| `prefix-changed` | 旧列表内某条 message 变了 | ❌ 前缀被改（缓存必断） |
| `rewind` | 新列表是旧列表的严格前缀（截断，如 /rewind） | 新请求的前缀 = 自身，合理 |
| `branch` | 新列表更短且中间有差异 | ❌ 分支/改写 |

注意：**diff 展示完整变更区，从不截断**；只有未变的头部/尾部上下文折叠为
`… N unchanged lines …` 计数行（全文本身在 `last-request.json`，无损）。

## 可靠性设计

- **永不影响 Agent**：整个 handler 包在 try/catch 里；任何异常只写一条
  `{"error": …}` 日志行，不抛出、不改 payload。响应路径本就不经过这里。
- **原子写**：`last-request.json` 走临时文件 + rename，不会写半个文件。
- **磁盘故障降级**：写盘失败后自动转为纯内存观测（内存里仍保留上一份全文，
  UI 通知照常），不抛错。
- **内存有界**：只保留最近一份全文字符串。
- **跨进程延续**：进程重启后第一个请求会与磁盘上上一个进程的最后一份全文对比
  （`crossRestart: true`；新会话上下文全新属预期，只在 tools/system 变化时通知）。
- **零运行时依赖**：不装任何包即可运行；纯 Node fs + JSON。
- **已知限制**：同一 cwd 同时跑多个 pi 会话时，它们共享 `log.jsonl` 并互相覆盖
  `last-request.json`（用 `process` 字段区分行来源）；一个会话只开一个哨兵。

## 何时会 UI 通知（warning）

- 会话内：`classification` 为 `prefix-changed` / `branch` / `rewind`，或 `toolsChanged` / `systemChanged`
- 跨进程重启：只在新上下文与上一次请求**有实质重叠**（`commonPrefixMessages > 0`）且发生分歧，
  或 `toolsChanged` / `systemChanged` 时通知（全新会话上下文属预期，不通知）
- 纯 `modelChanged` 只记日志不通知（通常是你主动切的模型）

## 安装

```powershell
pi install "D:\01-R&D\Project-prefix-sentinel"
```

不需要 `npm install`（无运行时依赖）。typecheck 需要 devDependencies：

```powershell
npm install
node node_modules/typescript/bin/tsc -p tsconfig.json   # 仓库路径含 & 时 .bin shim 会失败，用 node 直调
bun test test/
```

## 与 pi-vcc-plus 的关系

完全独立：零共享代码、零共享状态，可单独启用/禁用，也可同时启用。

**能看到什么 / 看不到什么**（已对 pi 0.85.1 源码核实）：

- **能看到**：Agent 正常回合的每一条请求，以及压缩后的第一批请求——这些都走
  Agent 的 stream 路径，会触发 `onPayload` → `before_provider_request`。
- **看不到**：pi-vcc-plus 的**校验请求**。它走 `ctx.modelRegistry.complete(...)` →
  `ModelRegistry.complete` → `runtime.complete`（model-registry.js:65-67），不经过 Agent，
  model-registry / model-runtime 里没有任何 `onPayload`。

所以“B 面”（校验请求前缀是否等于上一次真实请求）由 **pi-vcc-plus 自己**验证：
校验请求经自定义 fetch 发出，出站 body 的 `tools` 用捕获到的 wire JSON 原样替换，
body 写入 `.pi/prefix-sentinel/check-request.json`，再由 pi-vcc-plus 与哨兵的
`last-request.json` 做字节级前缀比较，结果（`prefixIdentical` + 首个分歧位置）写进
pi-vcc-plus 自己的 `checkPrefix` 日志。

证据链分工：

| 证据 | 来源 | 覆盖 |
|---|---|---|
| 正常回合前缀稳定性（A 面） | 哨兵 `log.jsonl` | 每次正常请求 |
| 校验请求字节一致（B 面） | pi-vcc-plus `checkPrefix` 日志 + `check-request.json` | 每次压缩校验 |
| KV 缓存实际复用 | pi-vcc-plus `round.prefixSuspect`（cacheRead 断言） | 每次校验请求 |
