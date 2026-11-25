# 设计说明与证据链

本文记录「为什么可以这样修」的全部依据。所有数字均为 2026-11-24 对 `https://api.codexhot.com/v1` 实测所得，可复现。

---

## 1. 现象

走 `/v1/responses` 时，一个内容只有 `"hi"` 的请求，`usage.input_tokens` 是 **4387**；而把同样的内容发到 `/v1/chat/completions`，`usage.prompt_tokens` 是 **7**。

两者差 4380。而响应里还带一个只有中转站会写的字段：

```json
"usage": {
  "input_tokens": 4387,
  "attribution": { "request_fields": { "instructions": { "input_tokens": 4380, "cached_tokens": 4224 } } }
}
```

**客户端在这 12 个实验请求里从来没有发送过 `instructions`**，这个字段却恒为 4380 —— 说明是服务端补的，而且服务端自己知道这是「补的」。

---

## 2. 触发条件：`instructions` 缺省或空白

同一句 `"hi"`，只改 `instructions`：

| `instructions` | `input_tokens` | 注入是否发生 |
|---|---|---|
| 不传 | 4387 | 是 |
| `""`（空串） | 4387 | 是 |
| `" "`（单个空格） | 4387 | 是 |
| `"."`（单字符） | **12** | 否 |
| `"You are a test harness."` | 17 | 否 |
| 约 1000 token 的填充串 | 1012 | 否 |

两条恒等式说明注入是「同一槽位的二选一」，而不是叠加：

```
4387 − 7    = 4380        ← 无 instructions 时：底座 7 + 注入 4380
4418 − 38   = 4380        ← 换成长 developer 消息，常量不变
12  = 7 + 5               ← 有 instructions 时：底座 7 + tokens(".")
17  = 7 + 10
1012 = 7 + 1005
```

服务端逻辑近似于：

```js
const instr = (body.instructions ?? '').trim();
body.instructions = instr ? body.instructions : DEFAULT_CODEX_PROMPT;
```

`""` 与 `" "` 被 trim 判定为空，所以与「不传」等价 —— 这正是本插件必须补**非空白**字符串的原因。

---

## 3. 注入的内容是什么

让模型自述它收到的工具与规则（`apply_patch`、`multi_tool_use.parallel` 是 Codex CLI 独有工具名）：

> 工具名：`multi_tool_use.parallel`。说明中还提到 `rg`、`apply_patch`、`cat`、`sed`、`git`……**编辑前要先向用户简短说明准备改什么**；遇到可能破坏现有工作的操作时不能擅自执行，请求含糊时应先征求批准。

同一问题走 `/chat/completions`，回答是「没有列出任何可用工具」。

这就是旁白的来源：注入条款要求「编辑前先说明」「不确定先征求批准」，而 DSH 把每个 `text` 块渲染成独立助手消息，于是这些声明就变成了你看到的满屏旁白。Codex CLI 把同样的前言显示在工具调用上方的小字里，所以「看起来正常」。

---

## 4. 为什么 hook `globalThis.fetch` 可行

调用链是确定的，逐层查过：

```
pi-ai stream 请求
  └─ openai-responses.js:139   createClient(..., options?.fetch, ...)
       └─ openai-responses.js:238   { fetch, ... } 传给 OpenAI SDK 构造参数
            └─ openai/client.mjs:240   this.fetch = options.fetch ?? Shims.getDefaultFetch()
                 └─ openai/internal/shims.mjs:7   function getDefaultFetch() { return fetch; }
```

关键两点：

1. `getDefaultFetch()` 是**函数调用**，发生在 `new OpenAI(...)` 里，返回的是**构造那一刻**的 `globalThis.fetch`；不是模块加载时就被固定下来的常量。
2. pi-ai 在**每次请求**时都重新 `createClient`（`openai-responses.js:139` 位于请求函数内部），不是复用长生命周期客户端。

因此顺序成立：插件先包装 `globalThis.fetch` → 之后每个新客户端都拿到包装后的版本。

插件挂载发生在 DSH 启动阶段，远早于第一次 LLM 请求，时间上安全。

---

## 5. 已排除的其它解释

### 5.1 「中转站按客户端识别头决定是否注入」——证伪

试了 5 种组合，全部返回 4387：

| 请求头 | `input_tokens` |
|---|---|
| 无 | 4387 |
| `originator: codex_cli_rs` | 4387 |
| `user-agent: codex_cli_rs/0.48.0 (Windows 11) vscode` | 4387 |
| 上面两个一起 | 4387 |
| `x-client-name: codex` + `x-client-version: 0.48.0` | 4387 |
| 再加 `openai-beta` / `session_id` | 4387 |

**结论**：不存在「配置 `provider.headers` 就能绕过」的纯配置解法，必须改请求体。这也是本插件存在的理由。

### 5.2 「是客户端自己的系统提示词太长」——不是主因

DSH 自己的 system prompt 约 14.7K 字符，其中 47% 是某个注入的中文规程。它确实含「不得 / 禁止 / 边界」等措辞，但把 `instructions` 补成非空后，**注入消失、旁白随之大幅减少**；反过来，只精简 DSH prompt 而不处理注入，4380 token 依旧在。两者是叠加关系，注入是可控的那一半。

### 5.3 「是 reasoning 泄漏 / 安全拒答」——不是

样本里的旁白是真实的 `text` 块（`partType=text`），不是 reasoning；refusal 计数为 0。

---

## 6. 设计取舍

### 6.1 为什么 hook 全局 fetch，而不是包装 DSH 的 llm 服务

- DSH 的 provider 配置 schema 只暴露 `headers`，不支持追加任意请求体字段（已核对 `dsh-llm-pi-ai/lib/index.js:1058-1080`）；
- pi-ai 的 `buildParams` 里根本没有 `instructions`（`openai-responses.js:259-267`），所以没有任何配置项能补上它；
- 包装 llm 服务需要跟着 DSH 内部接口走，升级即碎；hook fetch 依赖的是 `openai` SDK 的公开行为，稳定得多。

### 6.2 为什么只白名单 `api.codexhot.com`

`globalThis.fetch` 是进程级的，误伤面必须压缩到最小。默认只处理明确已知有问题的 host，其它 responses 提供方（真 OpenAI、Azure、自建）一概不碰。要用在别处就把 host 加进 `hosts`。

### 6.3 为什么用语义化占位串而不是 `"."`

两者都能抑制注入，但 `instructions` 在 OpenAI 语义里是「系统指令」。塞一个 `"."` 虽然实测无害，仍不如一句中性英文稳妥：

```
Follow the developer instructions supplied in the input array.
```

它不引入任何新规则，只是把模型的注意力引回 `input` 里的 developer 消息，正好是 DSH 实际放系统提示词的地方。

### 6.4 为什么不在插件里顺手砍 DSH 的 prompt

插件只做一件事：让出站请求不被注入。精简 system prompt 属于另一层（改 profile 配置 / 关插件），混在一起会让故障定位变难。

---

## 7. 已知边界

- 只对**走 Responses API** 的请求有效。若 provider 配的是 `openai-completions`，本插件无事可做（那条通道本来就不注入）。
- 中转站若改变策略（例如也开始对 chat 通道注入），需要重新评估。
- 若某次上游把 `instructions` 用作「唯一系统提示」（某些实现会忽略 `input` 里的 developer 消息），占位串会盖掉真实系统提示。实测 codexhot 不会（`input` 中的 developer 消息照常生效），但换 host 时应先验证。
