# 安装指南

## 前置条件

| 项 | 要求 |
|---|---|
| DeepSeek Harness | 0.2.x（依赖 `openai` SDK v7 的 `getDefaultFetch()` 行为） |
| Node | ≥ 18（需要全局 `fetch` / `Request` / `Response`） |
| 目标 profile | 默认 `web`，路径 `C:\Users\73985\.dsh\profiles\web` |
| 前提 | 目标 provider 使用 `api: openai-responses` |

> 如果你的 provider 还是 `openai-completions`，本插件不会产生任何效果 —— 那条通道本来就没有注入。

---

## 步骤 1：把插件链接到 profile 的 node_modules

DSH 通过模块名解析插件，所以插件目录必须出现在 profile 的 `node_modules` 下。

### 方式 A：junction（推荐，改代码立即生效）

```powershell
cmd /c mklink /J "C:\Users\73985\.dsh\profiles\web\node_modules\dsh-codex-responses" "D:\dsh-codex-responses"
```

或使用仓库脚本：

```powershell
powershell -ExecutionPolicy Bypass -File D:\dsh-codex-responses\scripts\install.ps1
```

### 方式 B：直接复制（不打算改代码时）

```powershell
Copy-Item D:\dsh-codex-responses "C:\Users\73985\.dsh\profiles\web\node_modules\dsh-codex-responses" -Recurse
```

复制之后每次更新插件都要重新复制。

### 方式 C：作为 bundle 安装

`package.json` 里已经声明了 `dsh.bundle.patch`，如果你的 DSH 支持本地 bundle 安装，可以直接指向 `D:\dsh-codex-responses`，DSH 会读取 `cordis.patch.yml` 自动挂载。

---

## 步骤 2：在 profile 的 patch 层挂载插件

编辑 `C:\Users\73985\.dsh\profiles\web\cordis.patch.yml`，在**顶层数组末尾**追加：

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

注意：

- 这是顶层数组的一个元素，`- insert:` 顶格不缩进，真正的插件行**缩进 4 空格**；
- **必须用 `- insert:` 包裹**。patch 层的方言里，带 `id` 但没有 `insert` 的条目是"覆盖已存在的同名行"；目标行不存在时 DSH 只打一条警告然后静默跳过，插件既不出现也不报错——这是最常见的安装失败原因；
- 同一个 id 只能出现一次；
- 想同时保护多个中转站，就往 `hosts` 里加更多域名。

用脚本自动追加（Idempotent，自动备份，写盘前做中文编码自检）：

```powershell
node D:\dsh-codex-responses\scripts\apply-profile.mjs
```

该脚本默认同时把 `codexhot` / `codexhot-gtp61luna` / `codexhot-deepseek` 三个 provider 的 `api` 切到 `openai-responses`；只想装插件不动 provider 时加 `--providers=`（空值）。

> `install.ps1` 自己不做任何 YAML 编辑，`-PatchProfile` 只是转调 `apply-profile.mjs`。之所以要绕这一道：Windows PowerShell 5.1 默认按 ANSI 读取无 BOM 的 UTF-8，会把 `cordis.patch.yml` 里的中文（如 `displayName: 热核API`）写成乱码；`apply-profile.mjs` 使用 Node 的 UTF-8 读写，并在写盘前比对 CJK 字符数，异常即中止。

---

## 步骤 3：把目标 provider 切回 responses 通道

```yaml
      codexhot-deepseek:
        displayName: 热核福利组
        apiKeyEnv: CODEXHOT_DEEPSEEK_API_KEY
        api: openai-responses                 # ← 关键
        baseURL: https://api.codexhot.com/v1  # ← 必须是官方地址，不要填本地代理
```

`baseURL` 保持官方地址即可，插件在进程内改写请求，不需要中间代理。

---

## 步骤 4：重启 DSH

插件在启动时挂载。provider 配置虽然是 `patchReload: live`，但**新增插件条目必须重启进程才会进入 cordis 插件树**。

实测依据：写完条目后立即用 DSH 的插件管理接口遍历全部插件（228 条），其中**没有** `dsh-codex-responses`；重启后才会出现。所以不要指望热重载。

> ⚠️ 顺序提醒：如果你已经先把 provider 的 `api` 切成了 `openai-responses`，那么在重启之前，请求会处于「走 responses 通道但插件尚未加载」的状态 —— 中转站的注入会照常发生。**配置写入后请立即重启，不要中间插入对话。**

---

## 步骤 5：验证

### 5.1 看启动日志

重启后如果 `log: true`，会在第一次请求时打：

```
[codex-responses] inject: https://api.codexhot.com/v1/responses 补入 instructions（…）
```

`log: false` 时没有任何输出，属于正常。

### 5.2 跑自测

```powershell
# 离线：15 项断言，零成本，不联网
node D:\dsh-codex-responses\test\smoke.mjs

# 联网：额外验证一次真实上游
node D:\dsh-codex-responses\test\smoke.mjs --live --key=sk-xxxxxx
```

联网部分期望输出：

```
input_tokens = 21   instructions 归因 = 14
PASS  真实请求 input_tokens 已降到两位数
```

### 5.3 看真实会话

在 DSH 里新建会话，用 `codexhot-deepseek / gpt-6.2-sol` 发一句话。若该轮 `input_tokens` 是两位数到几百（取决于上下文），而不是「你的 prompt 量 + 4380」，即成功。

---

## 安装后自检清单

- [ ] `C:\Users\73985\.dsh\profiles\web\node_modules\dsh-codex-responses` 存在且能读到 `lib\index.js`
- [ ] `cordis.patch.yml` 里有且仅有一个 `codex-responses-fix` 条目
- [ ] 目标 provider 的 `api` 是 `openai-responses`
- [ ] DSH 已重启
- [ ] `node test\smoke.mjs` 全绿
- [ ] 真实会话的 `input_tokens` 不再包含那 4380
