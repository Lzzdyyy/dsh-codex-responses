#!/usr/bin/env node
/**
 * apply-profile.mjs
 * ===========================================================================
 * 把 dsh-codex-responses 插件写入 DSH profile 的 cordis.patch.yml，
 * 并把受影响的 provider 切回 openai-responses 通道。
 *
 * 两个关键点（都是踩过坑之后写进来的）：
 *
 * 1) Loader patch 的语义（见 DSH 文档 references/composition-reference.md）：
 *      有 insert: 的 patch = 追加新行；
 *      只有 id、没有 insert 的 patch = 覆盖【已存在】的那一行；
 *      覆盖不存在的行会被警告并【静默跳过】。
 *    所以新增插件必须写成 `- insert:` 包裹的形式，直接写 `- id:` 不会生效。
 *
 * 2) Windows PowerShell 5.1 默认按 ANSI 读取无 BOM 的 UTF-8 文件，
 *    中文会被按 GBK 解码后再写回，导致 profile 配置永久损坏。
 *    所以这里用 Node 的 'utf8' 读写，并在写盘前做 CJK 字符数比对。
 *
 * 用法：
 *   node scripts/apply-profile.mjs                 # 应用（自动备份）
 *   node scripts/apply-profile.mjs --dry-run       # 只预览，不写盘
 *   node scripts/apply-profile.mjs --providers=codexhot-deepseek
 *   node scripts/apply-profile.mjs --profile-dir="C:\Users\73985\.dsh\profiles\web"
 *   node scripts/apply-profile.mjs --revert        # 撤销本脚本的两项改动
 *
 * 幂等：重复执行不会重复插入条目，也不会重复改 api。
 * ===========================================================================
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const PROFILE_DIR = String(arg('profile-dir', 'C:\\Users\\73985\\.dsh\\profiles\\web'));
const DRY_RUN = arg('dry-run', false) === true;
const REVERT = arg('revert', false) === true;
const LOADER_ID = 'codex-responses-fix';
const PACKAGE_NAME = 'dsh-codex-responses';
const DEFAULT_PROVIDERS = ['codexhot', 'codexhot-gtp61luna', 'codexhot-deepseek'];

const providers = String(arg('providers', DEFAULT_PROVIDERS.join(',')))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const patchFile = join(PROFILE_DIR, 'cordis.patch.yml');
if (!existsSync(patchFile)) {
  console.error(`找不到 ${patchFile}`);
  process.exit(1);
}

const original = readFileSync(patchFile, 'utf8');
let next = original;

/* ---------------------------- 1. 插件条目 ------------------------------- */

/** 必须是 insert 形式：没有 insert 的 `- id:` 只会去覆盖已存在的行 */
const ENTRY = [
  '',
  '- insert:',
  `    - id: ${LOADER_ID}`,
  `      name: ${PACKAGE_NAME}`,
  '      config:',
  '        hosts:',
  '          - api.codexhot.com',
  '        log: false',
  '',
].join('\n');

/** 匹配任意缩进下的 `- id: <LOADER_ID>` 行（insert 内行缩进 4 空格） */
function idLineRegex(id, flags = 'm') {
  return new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${id}[ \\t]*$`, flags);
}

/**
 * 从文本里移除 `- id: <id>` 这一行及其子行；
 * 若它所在的 `- insert:` 块只有这一个子行，则整块删除。
 */
function removeEntry(text, id) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => idLineRegex(id).test(l));
  if (idx === -1) return { text, removed: false };

  const rowIndent = (lines[idx].match(/^[ \t]*/) || [''])[0].length;

  // 该行的结束位置：下一个缩进 <= rowIndent 的非空行
  let end = idx;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) {
      end = i;
      continue;
    }
    const ind = (lines[i].match(/^[ \t]*/) || [''])[0].length;
    if (ind <= rowIndent) break;
    end = i;
  }

  // 向上找父级（缩进更小的最近非空行）
  let parent = -1;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    const ind = (lines[i].match(/^[ \t]*/) || [''])[0].length;
    if (ind < rowIndent) {
      parent = i;
      break;
    }
  }

  const parentIsInsert = parent >= 0 && /^[ \t]*-[ \t]*insert:[ \t]*$/.test(lines[parent]);
  const onlyChild =
    parentIsInsert && lines.slice(parent + 1, idx).every((l) => !l.trim());

  const from = onlyChild ? parent : idx;
  lines.splice(from, end - from + 1);
  return { text: lines.join('\n'), removed: true, wholeBlock: onlyChild };
}

const hasEntry = idLineRegex(LOADER_ID).test(next);

if (REVERT) {
  if (hasEntry) {
    const r = removeEntry(next, LOADER_ID);
    next = r.text;
    console.log(`[revert] 已移除 ${LOADER_ID}${r.wholeBlock ? '（连同空的 insert 块）' : ''}`);
  } else {
    console.log('[revert] 没有找到插件条目，跳过');
  }
} else if (hasEntry) {
  console.log(`[entry] ${LOADER_ID} 已存在，跳过`);
} else {
  next = `${next.replace(/\s+$/, '')}\n${ENTRY}`;
  console.log(`[entry] 将追加 ${LOADER_ID} 条目（insert 形式）`);
}

/* ---------------------------- 2. provider api --------------------------- */

const target = REVERT ? 'openai-completions' : 'openai-responses';
const source = REVERT ? 'openai-responses' : 'openai-completions';

for (const provider of providers) {
  const safe = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 匹配：  provider:\n    若干更深的缩进行\n    api: <api>
  const toSource = new RegExp(
    `(\\n[ \\t]{6}${safe}:[ \\t]*\\r?\\n(?:[ \\t]{8,}.*\\r?\\n)*?[ \\t]{8}api:[ \\t]*)${source}(?=[ \\t]*\\r?\\n)`
  );
  const toTarget = new RegExp(
    `\\n[ \\t]{6}${safe}:[ \\t]*\\r?\\n(?:[ \\t]{8,}.*\\r?\\n)*?[ \\t]{8}api:[ \\t]*${target}(?=[ \\t]*\\r?\\n)`
  );

  if (toSource.test(next)) {
    next = next.replace(toSource, `$1${target}`);
    console.log(`[provider] ${provider}: ${source} → ${target}`);
  } else if (toTarget.test(next)) {
    console.log(`[provider] ${provider}: 已是 ${target}，跳过`);
  } else {
    console.log(`[provider] ${provider}: 未找到该 provider 或其 api 行，跳过`);
  }
}

/* ------------------------------- 写盘 ---------------------------------- */

if (next === original) {
  console.log('\n没有需要写入的变更。');
  process.exit(0);
}

// 安全校验：改动后中文不能变成乱码
const cjkBefore = (original.match(/[\u4e00-\u9fff]/g) || []).length;
const cjkAfter = (next.match(/[\u4e00-\u9fff]/g) || []).length;
const hasReplacementChar = next.includes('\uFFFD');
if (hasReplacementChar || cjkAfter < cjkBefore) {
  console.error(
    `\n[中止] 编码自检未通过：原文件 CJK 字符 ${cjkBefore} 个，新内容 ${cjkAfter} 个，` +
      `替换符=${hasReplacementChar}。未写入任何内容。`
  );
  process.exit(2);
}

if (DRY_RUN) {
  console.log('\n[dry-run] 未写盘。尾部预览：');
  console.log(next.slice(-500));
  process.exit(0);
}

const backup = `${patchFile}.bak-${Date.now()}`;
copyFileSync(patchFile, backup);
writeFileSync(patchFile, next, 'utf8');

console.log(`\n已写入 ${patchFile}`);
console.log(`备份: ${backup}`);
console.log(`CJK 字符数 ${cjkBefore} → ${cjkAfter}（用于确认中文未被破坏）`);
console.log('\nDSH 会监听 patch 层改动并热重载；若插件未出现在插件列表里，重启一次 DSH。');
