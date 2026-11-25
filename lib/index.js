/**
 * dsh-codex-responses
 * ===========================================================================
 * DeepSeek Harness 插件：绕开第三方中转站 `/v1/responses` 通道的系统提示词强制注入。
 *
 * ## 解决什么问题
 *
 * 部分中转站（如 api.codexhot.com）为了兼容 OpenAI Codex CLI，会在
 * `POST /v1/responses` 请求「未携带非空白 `instructions` 字段」时，
 * 自动前置注入约 4380 token 的 Codex CLI 官方系统提示词。后果：
 *
 *   1) 每个请求多计约 4380 input token（实测 4387 中 4380 是注入的）；
 *   2) 客户端自己的 developer/system 提示词与注入的 CLI 提示词并存，
 *      两套 agent 规则冲突，模型正文里出现大量「操作前声明 / 边界声明」旁白；
 *   3) 注入的提示词描述了 `apply_patch`、`multi_tool_use.parallel` 等
 *      Codex 独有工具，与客户端真实工具集不匹配，进一步放大规则校准输出。
 *
 * ## 怎么解决
 *
 * 中转站只在 `instructions` 缺失 / 空串 / 纯空白时才兜底注入。
 * 本插件在出站 HTTP 层给这类请求补一个**中性占位串**，使 `instructions` 恒为非空，
 * 注入即消失。客户端真正的系统提示词走 `input` 数组里的 `developer` 消息，
 * 与 `instructions` 字段互不干扰，行为完全不变。
 *
 * ## 为什么 hook 全局 fetch 有效
 *
 * pi-ai 的 Responses 适配器（`@earendil-works/pi-ai/dist/api/openai-responses.js`）
 * 在每次请求时都 `new OpenAI(...)` 构造客户端，而官方 `openai` SDK 在构造函数里执行
 * `this.fetch = options.fetch ?? Shims.getDefaultFetch()`，`getDefaultFetch()` 返回
 * 的是**构造那一刻**的 `globalThis.fetch`。因此只要本插件在任何 LLM 请求之前完成
 * 包装，pi-ai 后续新建的每个客户端都会拿到被包装过的 fetch。
 *
 * ## 安全性
 *
 * - 只拦截 `POST` + `host` 命中配置 + 路径以 `/responses` 结尾的请求；
 * - 请求体不是合法 JSON、或已带非空 `instructions`，一律原样透传；
 * - 任何内部异常都被吞掉并透传，绝不让插件成为故障点；
 * - 卸载插件时恢复原始 `globalThis.fetch`。
 *
 * @module dsh-codex-responses
 */

/* ------------------------------- 常量 ---------------------------------- */

/** 插件名（cordis 会用它做日志前缀与去重）。 */
export const name = 'dsh-codex-responses';

/** 本插件只做出站请求改写，不依赖任何 DSH 服务。 */
export const inject = [];

/** 全局安装标记，防止热重载 / 重复 apply 造成多层包装。 */
const HOOK_MARK = Symbol.for('dsh-codex-responses.hook');

/** 默认配置。 */
const DEFAULTS = Object.freeze({
  /** 只处理这些主机的请求；空数组表示不启用（安全默认）。 */
  hosts: ['api.codexhot.com'],
  /** 空 instructions 时补入的占位串，必须非空白。 */
  placeholder: 'Follow the developer instructions supplied in the input array.',
  /** 视为 responses 端点的路径后缀。 */
  pathSuffix: '/responses',
  /** 打印每次拦截/跳过的明细。 */
  log: false,
});

/* ------------------------------ 工具函数 -------------------------------- */

/** 从 fetch 的第一个参数里取出 URL 字符串。 */
function urlOf(input) {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

/** 判断是否为 Request 对象。 */
function isRequest(input) {
  return typeof Request !== 'undefined' && input instanceof Request;
}

/** 从请求头里剔除 content-length（body 被改写后长度会变）。 */
function withoutContentLength(headers) {
  if (!headers) return headers;

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const clone = new Headers(headers);
    clone.delete('content-length');
    return clone;
  }

  if (Array.isArray(headers)) {
    return headers.filter((pair) => String(pair?.[0] ?? '').toLowerCase() !== 'content-length');
  }

  if (typeof headers === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'content-length') continue;
      out[key] = value;
    }
    return out;
  }

  return headers;
}

/** 主机是否命中配置（同时比较 host 与 hostname，允许配置里带或不带端口）。 */
function hostMatches(url, hosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  return hosts.some((entry) => host === entry || hostname === entry);
}

/* ------------------------------ 请求改写 -------------------------------- */

/**
 * 尝试改写请求，使其带上非空 instructions。
 *
 * @returns {Promise<{input: any, init: any}|null>} 需要改写时返回新的调用参数，否则 null
 */
async function rewriteRequest(input, init, cfg, stats, log) {
  const url = urlOf(input);
  if (!url) return null;

  // 1) 只处理 POST
  const method = String(
    init?.method ?? (isRequest(input) ? input.method : 'GET')
  ).toUpperCase();
  if (method !== 'POST') return null;

  // 2) 只处理配置的主机
  if (!hostMatches(url, cfg.hosts)) return null;

  // 3) 只处理 responses 端点
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.endsWith(cfg.pathSuffix)) return null;

  stats.seen += 1;

  // 4) 取出请求体文本
  let bodyText = null;
  let isRequestInput = false;

  if (init && typeof init.body === 'string') {
    bodyText = init.body;
  } else if (init && init.body != null && typeof init.body !== 'string') {
    // Uint8Array / ArrayBuffer 之类：能解就解，解不了就放弃改写
    try {
      if (init.body instanceof Uint8Array) bodyText = new TextDecoder().decode(init.body);
      else if (init.body instanceof ArrayBuffer) bodyText = new TextDecoder().decode(new Uint8Array(init.body));
    } catch {
      bodyText = null;
    }
  } else if (!init && isRequest(input)) {
    isRequestInput = true;
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = null;
    }
  }

  if (typeof bodyText !== 'string' || bodyText === '') return null;

  // 5) 快速排除：不是 responses 请求体（必须含 input 字段）
  if (!bodyText.includes('"input"')) return null;

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  // 6) 已有非空 instructions → 保持不动
  const current = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';
  if (current) {
    stats.skipped += 1;
    log('skip', `${url} 已有 instructions，长度 ${current.length}`);
    return null;
  }

  // 7) 注入占位串
  payload.instructions = cfg.placeholder;
  const newBody = JSON.stringify(payload);
  stats.injected += 1;
  log('inject', `${url} 补入 instructions（${cfg.placeholder.length} 字符，原因：原来${payload.instructions === '' ? '空串' : '缺失'})`);

  if (isRequestInput) {
    const headers = withoutContentLength(new Headers(input.headers));
    const rebuilt = new Request(input.url, {
      method: input.method,
      headers,
      body: newBody,
      signal: input.signal,
      // @ts-ignore Node 18+ 需要 duplex 才能传流式 body
      duplex: 'half',
    });
    return { input: rebuilt, init: undefined };
  }

  return {
    input,
    init: { ...init, body: newBody, headers: withoutContentLength(init.headers) },
  };
}

/* ------------------------------ 安装/卸载 ------------------------------- */

function install(cfg, ctx) {
  const g = globalThis;

  if (g[HOOK_MARK]) {
    ctx.logger?.info?.('[codex-responses] 已有实例安装，复用现有 hook');
    return g[HOOK_MARK];
  }

  const original = g.fetch;
  if (typeof original !== 'function') {
    throw new Error('[codex-responses] globalThis.fetch 不可用，无法安装插件');
  }

  const stats = { seen: 0, injected: 0, skipped: 0, errors: 0 };

  const log = (kind, message) => {
    if (!cfg.log) return;
    const line = `[codex-responses] ${kind}: ${message}`;
    try {
      ctx.logger?.info?.(line) ?? console.log(line);
    } catch {
      console.log(line);
    }
  };

  const patched = async function dshCodexResponsesFetch(input, init) {
    try {
      const target = await rewriteRequest(input, init, cfg, stats, log);
      if (target) return original(target.input, target.init);
    } catch (error) {
      stats.errors += 1;
      log('error', `改写失败，按原样转发：${error?.message ?? error}`);
    }
    return original(input, init);
  };

  // 保留 fetch 的既有元信息，减少对其它库探测行为的干扰
  try {
    Object.defineProperty(patched, 'name', { value: 'fetch', configurable: true });
  } catch {
    /* 忽略 */
  }

  g.fetch = patched;
  g[HOOK_MARK] = stats;
  stats.original = original;
  stats.uninstall = () => {
    if (g.fetch === patched) g.fetch = original;
    if (g[HOOK_MARK] === stats) delete g[HOOK_MARK];
  };

  ctx.logger?.info?.(
    `[codex-responses] 已启用；hosts=${JSON.stringify(cfg.hosts)}，` +
    `placeholder="${cfg.placeholder}"`
  );
  return stats;
}

/* -------------------------------- 入口 ---------------------------------- */

/**
 * cordis 插件入口。
 *
 * @param {any} ctx cordis 上下文
 * @param {Partial<typeof DEFAULTS>} config 插件配置
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };

  if (!Array.isArray(cfg.hosts) || cfg.hosts.length === 0) {
    ctx.logger?.info?.('[codex-responses] hosts 为空，插件不生效');
    return;
  }
  cfg.hosts = cfg.hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  cfg.placeholder = String(cfg.placeholder ?? '');
  if (!cfg.placeholder.trim()) {
    throw new Error('[codex-responses] placeholder 不能为空或纯空白，否则中转站仍会注入');
  }
  cfg.pathSuffix = String(cfg.pathSuffix || DEFAULTS.pathSuffix);

  const stats = install(cfg, ctx);
  const dispose = () => {
    stats.uninstall?.();
    ctx.logger?.info?.(
      `[codex-responses] 已卸载；累计注入 ${stats.injected} 次，` +
      `跳过 ${stats.skipped} 次（已有 instructions），错误 ${stats.errors} 次`
    );
  };

  // cordis 的 effect 会在插件卸载/重载时自动执行清理，优先使用
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'codex-responses-fix: restore globalThis.fetch');
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', dispose);
  }
}

/** 供测试直接调用：把改写逻辑暴露出去。 */
export const __internals = { rewriteRequest, hostMatches, withoutContentLength, DEFAULTS };
