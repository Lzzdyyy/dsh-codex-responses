# 排错手册

按症状查。

---

## 症状 1：装完了，`input_tokens` 还是 4387 左右

按顺序排查：

**① provider 真的走 responses 吗**

```powershell
Select-String -Path "C:\Users\73985\.dsh\profiles\web\cordis.patch.yml" -Pattern 'api:\s*openai' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

如果还是 `openai-completions`，插件无事可做 —— 那条通道没有注入。改成 `openai-responses`。

**② 插件有没有真的被加载**

把 `log: true` 打开，重启 DSH，然后在会话里发一句话。若控制台/Dsh 日志里没有任何 `[codex-responses]` 前缀输出，说明插件没挂上。

**③ 模块名能不能被解析**

```powershell
node -e "console.log(require.resolve('dsh-codex-responses', {paths:['C:\\Users\\73985\\.dsh\\profiles\\web']}))"
```

报 `MODULE_NOT_FOUND` 就是 junction/复制没做对。

**④ hook 是否在 client 构造前装好**

本插件依赖「`openai` SDK 在构造 client 时读取 `globalThis.fetch`」。如果 DSH 换成了复用长生命周期 client 的实现，hook 会失效。判断方法：把 `log: true` 打开后，**任何**对话都不产生 `[codex-responses] inject/skip` 行，但模块解析又是正常的 → 就是这种情况。

此时改用本地 HTTP 代理方案（见 `D:\dsh-codex-responses\..\` 之外的 `proxy.mjs`，或另行搭建），因为代理在传输层，与 SDK 实现无关。

---

## 症状 2：DSH 启动报错，或插件加载失败

报错里如果出现：

```
[codex-responses] placeholder 不能为空或纯空白
```

说明配置里 `placeholder` 被写成了 `""` 或 `" "` —— 中转站会当作「未提供」，所以插件主动拒绝启动。填一个非空白串，或直接删掉这一行用默认值。

如果报 `globalThis.fetch 不可用`，说明运行环境没有原生 fetch（Node < 18），升级 Node。

如果报 `Cannot find module 'dsh-codex-responses'`，回到症状 1 的第 ③ 条。

---

## 症状 3：别的 provider 也被改写了

插件只处理 `hosts` 白名单里的主机的 `POST …/responses`。如果发现误伤：

1. 检查 `hosts` 是否写宽了（比如写成了 `api.openai.com`）；
2. 开 `log: true`，看打出来的 URL 是哪个；
3. 收敛 `hosts` 到只有问题域名。

默认值 `["api.codexhot.com"]` 是刻意保守的。

---

## 症状 4：chat 通道的请求被拦了

不应该发生。插件要求路径以 `/responses` 结尾，`/chat/completions` 不匹配。

如果确实发生，`log: true` 看具体 URL，然后把 `pathSuffix` 收紧或检查是否有网关把 chat 路径也映射成了 `/responses`。

---

## 症状 5：想临时关掉插件

三种办法，从轻到重：

1. **配置层禁用**：在 profile 的 `cordis.patch.yml` 里覆盖插件条目，补上 `disabled: true`：

   ```yaml
   - id: codex-responses-fix
     disabled: true
   ```

   > 这是"覆盖已存在的行"，只在插件**已经通过 `- insert:` 成功挂载**之后才有效。如果插件从未出现在插件列表里，问题出在挂载那一步——见下面「症状 9」。

2. **provider 换通道**：把 `api` 改回 `openai-completions`（天然免疫，但没有 reasoning summary）。

3. **卸载**：见 README 第七节。

---

## 症状 6：升级 DSH 之后失效

本插件不修改 DSH 的任何文件，升级不会破坏它。但升级可能：

- 换掉 `openai` SDK 版本（若新版本改变了 `getDefaultFetch()` 的取值时机，hook 会失效）→ 回到症状 1 的第 ④ 条验证；
- 重置 `cordis.patch.yml`（某些升级流程会重写 profile 配置）→ 检查条目是否还在。

排查顺序：先看 patch 条目，再跑 `node test\smoke.mjs`（离线全绿说明插件代码本身没问题），再开 `log: true` 看有没有拦截记录。

---

## 症状 7：`instructions` 补上了，但模型行为变怪

理论上不会：客户端真正的系统提示词在 `input` 的 `developer` 消息里，与 `instructions` 是两个字段。

但如果某家上游把 `instructions` 当成**唯一的**系统提示（忽略 `input` 里的 developer 消息），占位串就会顶掉真实指令，模型会「失忆」。判断方法：让模型复述它收到的开发指令，如果它只重复占位串那句，就是这种上游。

对策：把 `placeholder` 换成你自己一句精简的系统提示，或者改回代理方案（代理也能改成追加而非替换）。

已知 codexhot **不存在**这个问题 —— 实测带占位串时，`input` 里的 developer 消息照常生效（模型能正确答出埋入其中的秘密词）。

---

## 症状 8：怎么确认插件真的改了请求而不是只改了本地变量

离线自测就是干这个的：`test/smoke.mjs` 用一个假的 `globalThis.fetch` 记录插件**最终转发出去**的 body，逐项断言注入/透传行为。15 项全绿即说明改写链路正确。

联网验证则看服务端返回的 `usage`：

```
input_tokens = 21   instructions 归因 = 14
```

`instructions 归因 = 14` 说明服务端认到了我们发的占位串（14 token），而不是它自己的 4380。

---

## 症状 9：重启 DSH 后，已安装插件列表里根本找不到它

DSH 不报错，`cordis.patch.yml` 里也确实写了这一条，但列表里就是没有。

**首要原因：条目没有用 `- insert:` 包裹。** patch 层的方言规定，带 `id` 但没有 `insert` 的条目是"覆盖已存在的同名行"；目标行不存在时 DSH 只打一条警告然后**静默跳过**。所以 `- id: codex-responses-fix` 这种写法会被整条丢弃。自检：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern 'codex-responses-fix' -Context 3,0
```

正确形态是上面三行里能看到 `- insert:`，插件行缩进 4 空格；错误形态是插件行与其它顶层元素一样顶格。

**次要原因**：junction 没建 / 名字对不上。检查 plugin 目录是否为 junction 且指向本仓库：

```powershell
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-codex-responses" | Select-Object LinkType,Target
```

**好消息**：patch 层是**热重载**的（`patchReload: live`）。把语法改对之后**不用重启**，插件列表会立刻多出：

```
entryId=include:codex-responses-fix  moduleName=dsh-codex-responses  enabled=true  fiberPhase=active
```

`fiberPhase=active` 才是真的跑起来了；只看到 `enabled=true` 而 phase 不是 active，说明模块加载报错了，去看症状 2。

---

## 附：常用诊断命令

```powershell
# 1) 配置里的 responses provider
Select-String -Path "C:\Users\73985\.dsh\profiles\web\cordis.patch.yml" -Pattern 'api: openai-responses|codex-responses-fix' -Context 2,2

# 2) junction 是否就位
Get-Item "C:\Users\73985\.dsh\profiles\web\node_modules\dsh-codex-responses" | Select-Object FullName,LinkType,Target

# 3) 插件能否被解析
node -e "console.log(require.resolve('dsh-codex-responses', {paths:['C:\\Users\\73985\\.dsh\\profiles\\web']}))"

# 4) 离线自测
node D:\dsh-codex-responses\test\smoke.mjs

# 5) 直连上游复现基线（不经过插件）
curl -sS https://api.codexhot.com/v1/responses -H "content-type: application/json" `
  -H "authorization: Bearer $env:CODEXHOT_API_KEY" `
  -d '{"model":"gpt-6.2-sol","input":"hi","store":false,"max_output_tokens":8}'
```
