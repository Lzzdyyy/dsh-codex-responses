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

## 步骤 1：以 bundle 方式安装（推荐，唯一推荐）

DSH 有两个不同的列表，别混淆：

| 界面 | 数据源 | 手工改 patch 层会出现吗 |
|---|---|---|
| 设置 → 插件（运行时插件清单） | loader 里的每一行 entry | 会 |
| 应用市场 → 已安装 | profile `package.json` 的 `dependencies` | **不会** |
| 设置 → 插件 → 插件管理 → 已安装 | `dependencies` + `dsh.profile.bundles` + 官方目录 | **不会** |

也就是说：**只把插件目录链接进 `node_modules` 再手工往 `cordis.patch.yml` 里插一行，插件能跑，但永远不会出现在「已安装」列表里。** 要让它在列表里可见、能开关、能升级，必须把它注册成 profile 的一个 bundle 包。

本插件 `package.json` 已声明：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

所以直接用 DSH 自带的插件管理器安装即可（会自动写 `dependencies`、装依赖、追加 `dsh.profile.bundles`）：

```
plugin_manager  action=install_bundle  target=D:/dsh-codex-responses
```

等价命令行（版本不同命令名可能略有差异）：

```powershell
dsh plugin install D:/dsh-codex-responses
```

安装成功后 `C:\Users\73985\.dsh\profiles\web\package.json` 会出现两处改动：

```json
"dependencies": {
  "dsh-codex-responses": "link:D:/dsh-codex-responses"
},
"dsh": {
  "profile": {
    "bundles": [ "...", "dsh-codex-responses" ]
  }
}
```

从 GitHub 安装（公开仓库）：

```
plugin_manager  action=install_bundle  target=https://github.com/Lzzdyyy/dsh-codex-responses
```

### 开发调试：为什么还需要 junction？

`install_bundle` 写入的是 `link:D:/dsh-codex-responses`，pnpm 会在 profile 的 `node_modules` 里建一个指向该目录的符号链接，改代码即时生效，**不需要**再手工 `mklink /J`。

只有当你完全不经过 profile 的 `package.json`、想临时验证模块解析时，才用 junction：

```powershell
cmd /c mklink /J "C:\Users\73985\.dsh\profiles\web\node_modules\dsh-codex-responses" "D:\dsh-codex-responses"
```

> ⚠️ 单做 junction **不会**让插件出现在任何「已安装」列表里，也不会让它进入 cordis 插件树 —— 它只解决模块解析。必须再经过步骤 1 的 bundle 注册。

---

## 步骤 2：patch 层由 bundle 自带，不要手工再插一遍

本插件的 `cordis.patch.yml`（仓库根目录）内容就是挂载本体：

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

bundle 注册后，DSH 启动时按 `dsh.profile.bundles` 的顺序叠加各 bundle 的 `dsh.bundle.patch`，再把 profile 自己的 `cordis.patch.yml` 叠上去。

> ⚠️ **不要在 profile 的 `cordis.patch.yml` 里再手工插一个 `id: codex-responses-fix`。** 同一个 id 出现两次会让组合阶段直接失败；而带 `id` 但没有 `- insert:` 包裹的条目是「覆盖已存在的同名行」，目标行不存在时 DSH 只打一条警告然后静默跳过 —— 插件不出现也不报错，这是最常见的安装失败原因。
>
> 如果你之前按老文档手工插过，先删掉那一段：
>
> ```powershell
> node D:\dsh-codex-responses\scripts\uninstall.ps1   # 或手工从 cordis.patch.yml 删除该 - insert: 块
> ```

想同时保护多个中转站，改 `hosts` 列表（改完需重启，或由 `patchReload: live` 生效）。

---

## 步骤 3：把目标 provider 切到 responses 通道

```yaml
      codexhot-deepseek:
        displayName: 热核福利组
        apiKeyEnv: CODEXHOT_DEEPSEEK_API_KEY
        api: openai-responses                 # ← 关键
        baseURL: https://api.codexhot.com/v1  # ← 必须是官方地址，不要填本地代理
```

`baseURL` 保持官方地址即可，插件在进程内改写请求，不需要中间代理。

---

## 步骤 4：重启 DSH（首次安装）

`install_bundle` 会在 HMR 可用时实时重组（返回 `application: "applied"`），此时刷新页面即可。但如果返回 `needsRestart` 或者插件首次进入 cordis 插件树，请重启 DSH 进程。

> ⚠️ 顺序提醒：如果你已经先把 provider 的 `api` 切成了 `openai-responses`，那么在重启之前，请求会处于「走 responses 通道但插件尚未加载」的状态 —— 中转站的注入会照常发生。**配置写入后请立即重启，不要中间插入对话。**

---

## 步骤 5：验证

### 5.1 看启动日志

`log: true` 时会在第一次请求时打：

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

- [ ] profile 的 `package.json` 的 `dependencies` 里有 `dsh-codex-responses`
- [ ] profile 的 `dsh.profile.bundles` 里有 `dsh-codex-responses`
- [ ] profile 的 `cordis.patch.yml` 里**没有**重复的 `codex-responses-fix` 条目
- [ ] 设置 → 插件 → 插件管理 → 已安装 里能看到本插件
- [ ] 目标 provider 的 `api` 是 `openai-responses`
- [ ] `node test\smoke.mjs` 全绿
- [ ] 真实会话的 `input_tokens` 不再包含那 4380

---

## 常见故障

### 插件在跑，但「已安装」列表里没有它

原因：只用 junction 链接了 `node_modules`，或只在 `cordis.patch.yml` 里手工插了一行，没有把包注册进 profile 的 `dependencies` / `dsh.profile.bundles`。

修复：用步骤 1 的 `install_bundle` 重装一次（会同时写入这两处），再删掉手工插入的 patch 行（避免 id 重复）。

### 插件加载了，但「设置 → 插件」里看不见

该页把插件按「全局 / 本 profile」分组，**「全局」组默认折叠**，用页面上的搜索框输入 `codex-responses` 即可定位。

### 安装后没有任何效果

按顺序检查：① provider 的 `api` 是否真的是 `openai-responses`；② 插件是否在当前 profile 的 `bundles` 里；③ `hosts` 是否覆盖了你实际请求的域名（`api.codexhot.com`）。
