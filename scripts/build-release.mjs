#!/usr/bin/env node
// Validates the userscript header and writes the release assets:
//   dist/download-ai-chat-pdf.user.js  — the script itself
//   dist/download-ai-chat-pdf.meta.js  — header only; userscript managers poll it (@updateURL)
//
// Usage:
//   node scripts/build-release.mjs            validate + write dist/
//   node scripts/build-release.mjs --check    validate only
//   node scripts/build-release.mjs --tag v1.2.3   also require @version === 1.2.3

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'download-ai-chat-pdf';
const srcPath = join(root, `${NAME}.user.js`);
const src = readFileSync(srcPath, 'utf8');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const tagIdx = args.indexOf('--tag');
const tag = tagIdx !== -1 ? args[tagIdx + 1] : process.env.RELEASE_TAG;

const errors = [];
const fail = (msg) => errors.push(msg);

const block = src.match(/^\/\/ ==UserScript==\n([\s\S]*?)\n\/\/ ==\/UserScript==\n/);
if (!block) {
    console.error('✗ No // ==UserScript== header block at the top of the file');
    process.exit(1);
}
const header = block[0];

const meta = {};
for (const line of block[1].split('\n')) {
    const m = line.match(/^\/\/\s+@(\S+)\s+(.*)$/);
    if (!m) continue;
    (meta[m[1]] ||= []).push(m[2].trim());
}
const one = (k) => (meta[k] ? meta[k][0] : undefined);

for (const k of ['name', 'namespace', 'version', 'description', 'author', 'license', 'updateURL', 'downloadURL', 'run-at']) {
    if (!one(k)) fail(`missing @${k}`);
}

const version = one('version');
if (version && !/^\d+\.\d+\.\d+$/.test(version)) fail(`@version "${version}" is not MAJOR.MINOR.PATCH`);

const constVersion = (src.match(/const VERSION = '([^']+)'/) || [])[1];
if (constVersion !== version) fail(`const VERSION ('${constVersion}') differs from @version ('${version}')`);

if (tag && tag.replace(/^v/, '') !== version) fail(`tag ${tag} differs from @version ${version}`);

const matches = meta.match || [];
for (const host of ['chatgpt.com', 'gemini.google.com', 'claude.ai', 'grok.com']) {
    if (!matches.some((m) => m.includes(host))) fail(`no @match for ${host}`);
}

const base = `https://github.com/RobyRew/Download-AI-Chat-PDF/releases/latest/download/${NAME}`;
if (one('updateURL') !== `${base}.meta.js`) fail(`@updateURL should be ${base}.meta.js`);
if (one('downloadURL') !== `${base}.user.js`) fail(`@downloadURL should be ${base}.user.js`);

// Gemini enforces Trusted Types: string-to-HTML sinks throw there.
const body = src.slice(header.length);
for (const sink of ['.innerHTML', '.outerHTML =', 'insertAdjacentHTML', 'document.write(']) {
    if (body.includes(sink)) fail(`uses ${sink} (blocked by Trusted Types on gemini.google.com)`);
}

try {
    execFileSync(process.execPath, ['--check', srcPath], { stdio: 'pipe' });
} catch (e) {
    fail(`syntax error:\n${e.stderr}`);
}

if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
}

console.log(`✓ ${one('name')} v${version} — ${matches.length} @match rules`);

if (!checkOnly) {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, `${NAME}.user.js`), src);
    writeFileSync(join(dist, `${NAME}.meta.js`), header);
    console.log(`✓ wrote dist/${NAME}.user.js and dist/${NAME}.meta.js`);
}
