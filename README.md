# dsh-codex-responses

DeepSeek Harness 插件：**绕开第三方中转站 `/v1/responses` 通道的系统提示词强制注入**，消除多余的 token 计费，以及由此引发的「模型正文里大量边界声明 / 操作前旁白」。

> **一句话概括**
>
> 部分 GPT 中转站会在 Responses API 下、当请求体的 `instructions` 为空时，自动注入一份 Codex 默认提示词；而 DeepSeek Harness 默认不发送 `instructions` 字段，于是上游 API 同时收到**两份 system prompt** —— 一套来自中转站的 Codex 提示词，一套来自 DSH 自己的系统提示。两套规则大量重复又局部冲突，模型被迫在正文里反复对齐边界，输出质量随之下降。本插件正是为解决这个问题而写：它在出站请求里补一个非空 `instructions`，让中转站不再兜底注入，从而只保留 DSH 自己的那一份 system prompt。

> 实测效果：同一个请求，`input_tokens` 从 **4387** 降到 **21**，工具调用与流式行为完全不变。

---

## 一、它解决什么问题

部分中转站（已知：`api.codexhot.com`）为了兼容 OpenAI Codex CLI，会在 `POST /v1/responses` 请求「没有携带非空白 `instructions` 字段」时，**自动前置注入约 4380 token 的 Codex CLI 官方系统提示词**。

如果你的客户端符合下面两条，就会中招：

1. 走 `/v1/responses` 通道（OpenAI Responses API）；
2. 客户端自己不发 `instructions` 字段，而是把自己的系统提示词放在 `input` 数组的 `developer` 消息里（DeepSeek Harness 的 pi-ai 适配器正是如此）。

中招后的症状：

| 症状 | 说明 |
|---|---|
| 每次请求的 `input_tokens` 莫名多出约 4380 | 账单上升，缓存命中只是折扣，不算消失 |
| 模型正文里反复出现「我只做只读分析」「本轮不修改文件」「已确认没有破坏性操作」 | 注入的 CLI 提示词要求「编辑前先简短说明」「不确定先征求批准」，与客户端自己的规则并存 |
| 模型提到自己没见过的工具 | 注入文本描述了 `apply_patch`、`multi_tool_use.parallel` 等 Codex 独有工具 |
| 同样是这个中转站，Codex 客户端却「正常」 | Codex 自己本来就发同一份 instructions，注入对它属于幂等重复 |

---

## 二、工作原理（一句话）

中转站只在 `instructions` **缺失 / 空串 / 纯空白** 时才兜底注入。本插件在出站 HTTP 层给这类请求补一个中性占位串，`instructions` 恒为非空，注入即消失。

客户端真正的系统提示词在 `input` 的 `developer` 消息里，**与 `instructions` 字段互不干扰** —— 实测把占位串塞进去之后，`input` 里的指令照常生效（模型能正确答出埋入 developer 消息中的秘密词）。

### 为什么 hook `globalThis.fetch` 是可靠的

不是猜测，是查过源码的：

- `@earendil-works/pi-ai/dist/api/openai-responses.js` 在**每次请求时**都 `new OpenAI(...)` 构造客户端；
- 官方 `openai` SDK（v7）在构造函数里执行 `this.fetch = options.fetch ?? Shims.getDefaultFetch()`；
- 而 `Shims.getDefaultFetch()` 返回的是**构造那一刻**的 `globalThis.fetch`。

所以只要插件在任何 LLM 请求之前完成包装，pi-ai 之后新建的每个客户端都会拿到被包装过的 fetch。DSH 启动时加载插件远早于第一次对话，满足这个前提。

详细证据链见 [docs/design.md](docs/design.md)。

---

## 三、30 秒判断你有没有中招

```bash
KEY=sk-xxxxxx

# 输入只有 "hi"，看 input_tokens
curl -sS https://api.codexhot.com/v1/responses \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" \
  -d '{"model":"gpt-6.2-sol","input":"hi","store":false,"max_output_tokens":8}'
```

- `input_tokens` ≈ **4387** → 中招，装本插件；
- `input_tokens` ≈ **7** → 中转站没这问题，或你已走了 `/chat/completions`。

再补一条更直接的判据：

```bash
# 加一个 "." 当 instructions，注入应该立刻消失
curl -sS https://api.codexhot.com/v1/responses \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" \
  -d '{"model":"gpt-6.2-sol","input":"hi","store":false,"max_output_tokens":8,"instructions":"."}'
```

`input_tokens` 掉到 **12** 左右，就证明「补非空 instructions 即可」这条路径成立。

---

## 四、安装

> 完整分步说明见 [docs/install.md](docs/install.md)。这里是最短路径。

### 1. 作为 bundle 安装（推荐，也是唯一能让它在「已安装」里可见的方式）

本插件 `package.json` 已声明 `dsh.bundle.patch`，所以直接交给 DSH 的插件管理器安装即可——它会写 profile 的 `dependencies`、装依赖、把包名追加进 `dsh.profile.bundles`：

```
plugin_manager  action=install_bundle  target=D:/dsh-codex-responses
```

从 GitHub 安装：

```
plugin_manager  action=install_bundle  target=https://github.com/Lzzdyyy/dsh-codex-responses
```

安装成功后 `C:\Users\73985\.dsh\profiles\web\package.json` 会有两处改动：

```json
"dependencies": { "dsh-codex-responses": "link:D:/dsh-codex-responses" },
"dsh": { "profile": { "bundles": [ "...", "dsh-codex-responses" ] } }
```

> ⚠️ 只做 `mklink /J` 把目录链接进 `node_modules`、再手工往 `cordis.patch.yml` 插一行，插件**能跑**，但「应用市场 → 已安装」和「插件管理 → 已安装」**永远不会列出它**——这两个列表的数据源是 profile 的 `dependencies` / `dsh.profile.bundles`，不是 patch 层的行。改代码即时生效的 `link:` 安装方式已经覆盖了开发场景，不需要手工 junction。

### 2. patch 层由 bundle 自带，不要手工再插一遍

仓库根目录的 `cordis.patch.yml` 就是挂载本体：

```yaml
- insert:
    - id: codex-responses-fix
      name: dsh-codex-responses
      config:
        hosts:
          - api.codexhot.com
        placeholder: Follow the developer instructions supplied in the input array.
        log: false
```

> ⚠️ **不要在 profile 的 `cordis.patch.yml` 里再手工插一个 `id: codex-responses-fix`。** 同一 id 出现两次会让组合阶段直接失败；而带 `id` 但没有 `- insert:` 包裹的条目是「覆盖已存在的同名行」，目标行不存在时 DSH 只打警告然后静默跳过——插件不出现也不报错，这是最常见的安装失败原因。老文档里手工插过的话，先删掉那一段。

想同时保护多个中转站，改 `hosts` 列表。

### 3. 把 provider 改回 responses 通道

插件只在走 `/v1/responses` 时才有意义。把目标 provider 的 `api` 改回来：

```yaml
      codexhot-deepseek:
        displayName: 热核福利组
        apiKeyEnv: CODEXHOT_DEEPSEEK_API_KEY
        api: openai-responses                 # ← 从 openai-completions 改回
        baseURL: https://api.codexhot.com/v1  # ← 保持官方地址，不要指向代理
```

### 4. 重启 DSH

插件和 provider 配置都在启动/热重载时生效。provider 配置是 `patchReload: live`，但**插件首次挂载需要重启 DSH 进程**。

### 5. 验证

```powershell
node D:\dsh-codex-responses\test\smoke.mjs --live --key=sk-xxxxxx
```

期望看到 `input_tokens = 21` 左右、`16 passed, 0 failed`。

---

## 五、配置项

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `hosts` | string[] | `["api.codexhot.com"]` | 只处理这些主机的请求。同时匹配 `host`（含端口）与 `hostname`。**空数组 = 插件不生效**（安全默认）。 |
| `placeholder` | string | `"Follow the developer instructions supplied in the input array."` | 空 `instructions` 时补入的串。必须非空白，否则插件启动即报错。约 14 token。 |
| `pathSuffix` | string | `"/responses"` | 视为 responses 端点的路径后缀。 |
| `log` | boolean | `false` | 打开后每次拦截/跳过都打一行日志，便于排错。 |

想更省 token 可以把 `placeholder` 换成 `"."`（约 5 token），效果相同。
**不要**用 `""` 或 `" "` —— 中转站会当作「未提供」，注入照旧。

多个中转站都受影响时，`hosts` 直接列多个：

```yaml
    hosts:
      - api.codexhot.com
      - another-gateway.example.com
```

---

## 六、它不会做什么

- 不改 `/chat/completions`、不对其它路径动手；
- 不碰你的请求体里除 `instructions` 之外的任何字段（已有单测覆盖）；
- 不改响应、不缓冲流式数据（只在请求发出前做一次 JSON 改写）；
- 不会因为自身异常阻断业务：任何改写失败都原样透传；
- 不收集、不记录你的 API key 或对话内容（`log: true` 也只打 URL 和长度）。

---

## 七、卸载

```powershell
# 1) 从 cordis.patch.yml 删掉 codex-responses-fix 条目
# 2) 删掉 junction（脚本会先校验它确实是 junction，不会误删真实目录）
powershell -ExecutionPolicy Bypass -File D:\dsh-codex-responses\scripts\uninstall.ps1
```

或者干脆把 provider 的 `api` 改回 `openai-completions`，天然免疫（代价是看不到 reasoning summary）。

---

## 八、与其它方案对比

| | 本插件 | 本地代理 | 改 pi-ai 源码 | chat 通道 |
|---|---|---|---|---|
| 常驻进程 | 不需要 | 需要 | 不需要 | 不需要 |
| 保留 reasoning summary | ✅ | ✅ | ✅ | ❌ |
| DSH 升级影响 | 无（插件独立） | 无 | 版本目录被覆盖，需重打 | 无 |
| 失败面 | 极小（只影响带 input 的 POST /responses） | 代理挂了全挂 | 改第三方包 | 无 |
| 可观测性 | `log: true` 有明细 | 有 | 无 | 无 |

---

## 九、目录结构

```
D:\dsh-codex-responses\
├── package.json            # 包元信息 + dsh.bundle.patch
├── cordis.patch.yml        # bundle 层挂载片段
├── lib\
│   └── index.js            # 插件主体（唯一的运行时代码）
├── docs\
│   ├── design.md           # 原理与完整证据链（为什么这么断言）
│   ├── install.md          # 分步安装与验证
│   └── troubleshooting.md  # 排错手册
├── test\
│   └── smoke.mjs           # 自测：15 项离线断言 + 可选联网验证
├── scripts\
│   ├── install.ps1         # 建 junction
│   └── uninstall.ps1       # 安全移除 junction
└── README.md
```

---

## 十、变更记录

### 1.0.0
- 首个版本：hook `globalThis.fetch`，对匹配主机的 `POST .../responses` 请求补非空 `instructions`。
- 幂等安装、可安全卸载、异常透传。
- 实测：`input_tokens` 4387 → 21，工具调用与 SSE 行为不变。

---

## License

MIT
