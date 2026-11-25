#!/usr/bin/env node
/**
 * dsh-codex-responses 自测
 * ===========================================================================
 *   node test/smoke.mjs                 # 离线单元测试（不发网络请求，零成本）
 *   node test/smoke.mjs --live --key=sk-xxxx   # 追加一次真实上游请求验证
 *
 * 离线部分用一个假的 globalThis.fetch 记录插件实际转发了什么，
 * 从而验证「什么时候改写、什么时候原样透传」这一套判定逻辑。
 * ===========================================================================
 */

import { apply, __internals } from '../lib/index.js';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const LIVE = arg('live', false) === true;
const KEY = arg('key', process.env.CODEXHOT_API_KEY || '');
const MODEL = String(arg('model', 'gpt-6.2-sol'));

/* ------------------------------ 测试装置 -------------------------------- */

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` → ${detail}` : ''}`);
  }
}

const logs = [];
const cleanups = [];
const fakeCtx = {
  logger: { info: (m) => logs.push(String(m)) },
  effect: (fn) => {
    const disposer = fn();
    if (typeof disposer === 'function') cleanups.push(disposer);
  },
};

/** 记录插件最终转发出去的请求 */
let forwarded = null;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  forwarded = {
    url: typeof input === 'string' ? input : input?.url,
    init: init ?? {},
    bodyText: typeof init?.body === 'string' ? init.body : null,
  };
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
/** 插件应当包装的就是这一层（而非 realFetch） */
const mockFetch = globalThis.fetch;

const PLACEHOLDER = 'Follow the developer instructions supplied in the input array.';
apply(fakeCtx, { hosts: ['api.codexhot.com'], placeholder: PLACEHOLDER, log: false });

const URL_RESPONSES = 'https://api.codexhot.com/v1/responses';
const URL_CHAT = 'https://api.codexhot.com/v1/chat/completions';
const URL_OTHER_HOST = 'https://api.openai.com/v1/responses';

const baseBody = (extra = {}) => JSON.stringify({ model: MODEL, input: 'hi', store: false, ...extra });

/** 发一次请求，返回插件是否改写了 body */
async function send(url, bodyText, method = 'POST') {
  forwarded = null;
  await globalThis.fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'content-length': '999' },
    ...(method === 'GET' ? {} : { body: bodyText }),
  });
  return forwarded;
}

/* ------------------------------- 用例 ---------------------------------- */

console.log('--- 应该注入 ---');

{
  const f = await send(URL_RESPONSES, baseBody());
  const body = JSON.parse(f.bodyText);
  check('缺省 instructions → 补入占位串', body.instructions === PLACEHOLDER, JSON.stringify(body.instructions));
}

{
  const f = await send(URL_RESPONSES, baseBody({ instructions: '' }));
  check('instructions="" → 补入占位串', JSON.parse(f.bodyText).instructions === PLACEHOLDER);
}

{
  const f = await send(URL_RESPONSES, baseBody({ instructions: '   ' }));
  check('instructions 纯空白 → 补入占位串', JSON.parse(f.bodyText).instructions === PLACEHOLDER);
}

{
  const f = await send(URL_RESPONSES, baseBody());
  const keys = Object.keys(f.init.headers || {}).map((k) => k.toLowerCase());
  check('改写后剔除 content-length 头', !keys.includes('content-length'), JSON.stringify(keys));
}

{
  const f = await send(URL_RESPONSES, baseBody());
  check('原请求的其它字段不被破坏', JSON.parse(f.bodyText).model === MODEL && JSON.parse(f.bodyText).store === false);
}

console.log('\n--- 不应该注入 ---');

{
  const f = await send(URL_RESPONSES, baseBody({ instructions: 'You are a test harness.' }));
  check('已有非空 instructions → 原样透传', JSON.parse(f.bodyText).instructions === 'You are a test harness.');
}

{
  const f = await send(URL_OTHER_HOST, baseBody());
  check('非配置主机 → 不改写', JSON.parse(f.bodyText).instructions === undefined);
}

{
  const f = await send(URL_CHAT, JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }));
  check('chat/completions 路径 → 不改写', JSON.parse(f.bodyText).instructions === undefined);
}

{
  const f = await send(URL_RESPONSES, baseBody(), 'GET');
  check('GET 请求 → 不改写', f.bodyText === null);
}

{
  const f = await send(URL_RESPONSES, '{not-json');
  check('请求体非 JSON → 原样透传', f.bodyText === '{not-json');
}

{
  const f = await send(URL_RESPONSES, JSON.stringify({ model: MODEL, prompt: 'hi' }));
  check('无 input 字段（非 responses 请求体）→ 不改写', JSON.parse(f.bodyText).instructions === undefined);
}

console.log('\n--- 装配与卸载 ---');

{
  // 重复 apply 不应叠加多层包装
  apply(fakeCtx, { hosts: ['api.codexhot.com'], placeholder: PLACEHOLDER, log: false });
  const f = await send(URL_RESPONSES, baseBody());
  const parsed = JSON.parse(f.bodyText);
  check('重复 apply 不造成重复包装', parsed.instructions === PLACEHOLDER && !String(parsed.instructions).includes(PLACEHOLDER + PLACEHOLDER));
}

{
  check('安装期间 globalThis.fetch 已被替换', globalThis.fetch !== mockFetch);
  for (const dispose of cleanups) dispose();
  check('卸载后 globalThis.fetch 已恢复', globalThis.fetch === mockFetch);
  forwarded = null;
  await globalThis.fetch(URL_RESPONSES, { method: 'POST', body: baseBody() });
  check('卸载后不再改写', JSON.parse(forwarded.bodyText).instructions === undefined);
}

/* ----------------------------- 联网验证 --------------------------------- */

if (LIVE) {
  console.log('\n--- 真实上游验证 ---');
  if (!KEY) {
    console.log('  跳过：需要 --key=sk-... 或 CODEXHOT_API_KEY');
  } else {
    globalThis.fetch = realFetch;
    apply({ logger: { info: () => {} }, effect: (fn) => fn() }, {
      hosts: ['api.codexhot.com'],
      placeholder: PLACEHOLDER,
      log: false,
    });

    const res = await globalThis.fetch(URL_RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, input: 'hi', store: false, max_output_tokens: 8 }),
    });
    const json = await res.json();
    const inTok = json?.usage?.input_tokens ?? null;
    const instrTok = json?.usage?.attribution?.request_fields?.instructions?.input_tokens ?? null;
    console.log(`  input_tokens = ${inTok}   instructions 归因 = ${instrTok}`);
    check('真实请求 input_tokens 已降到两位数', inTok !== null && inTok < 100, `实际 ${inTok}`);
    globalThis.fetch = realFetch;
  }
}

/* ------------------------------- 汇总 ---------------------------------- */

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
