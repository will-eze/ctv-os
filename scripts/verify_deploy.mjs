#!/usr/bin/env node
// CTV OS — prove the deploy artifact works under the headers we ship with.
//
//   node scripts/verify_deploy.mjs
//
// vercel.json sets a deliberately tight Content-Security-Policy. A CSP that is
// slightly too tight does not fail the build; it fails silently in the browser,
// on the deployed URL, in front of whoever opened it. So this serves dist/ with
// the real headers from vercel.json, loads it in real Chrome, and listens for
// securitypolicyviolation. Nothing here trusts the config by reading it.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const html = readFileSync(join(root, vercel.outputDirectory, 'index.html'));

const headers = Object.fromEntries(
  (vercel.headers ?? [])
    .flatMap((rule) => rule.headers)
    .map((h) => [h.key, h.value])
);

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});
const page = await browser.newPage();

const violations = [];
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.evaluateOnNewDocument(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
  });
});

const external = [];
page.on('request', (r) => {
  if (r.url() !== url && !r.url().startsWith('data:')) external.push(r.url());
});

await page.goto(url, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 400));
violations.push(...(await page.evaluate(() => window.__csp)));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check('served with a CSP at all', !!headers['Content-Security-Policy'],
  headers['Content-Security-Policy']?.slice(0, 52) + '…');
check('no CSP violations on load', violations.length === 0, violations.join(' | ') || 'none');
check('no page or console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');
check('no external requests', external.length === 0, external.join(' | ') || 'self-contained');

// The font is the thing a CSP most often kills, and its absence is invisible in
// a smoke test that only checks for errors.
check('Inter actually rendered', await page.evaluate(() => document.fonts.check('700 32px Inter')),
  await page.evaluate(() => getComputedStyle(document.body).fontFamily.split(',')[0]));

const shell = await page.evaluate(() => ({
  views: document.querySelectorAll('.view').length,
  nav: document.querySelectorAll('.nav-item').length,
  days: document.querySelectorAll('.day[data-day]').length,
}));
check('the app rendered', shell.views === 5 && shell.nav === 5,
  `${shell.views} views, ${shell.nav} nav items`);

// Inline handlers are the other common CSP casualty: the page looks perfect and
// nothing responds. Drive a real mutation through to localStorage.
const mutated = await page.evaluate(() => {
  document.querySelector('[data-view="tasks"]').click();
  const box = document.querySelector('[data-task]');
  const id = box.dataset.task;
  box.click();
  const saved = JSON.parse(localStorage.getItem('ctvos.year.v2'));
  return { id, done: saved.tasks.find((t) => t.id === id)?.done, toast: !document.getElementById('toast').hidden };
});
check('interaction works and persists', mutated.done === true, `${mutated.id} ticked and stored`);
check('undo is offered', mutated.toast, 'toast shown');

violations.push(...(await page.evaluate(() => window.__csp)));
check('no CSP violations after interacting', violations.length === 0, violations.join(' | ') || 'none');

await browser.close();
server.close();

console.log(`\n  DEPLOY ARTIFACT — ${vercel.outputDirectory}/index.html served with vercel.json headers`);
console.log('  ' + '-'.repeat(70));
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(38)} ${c.detail ?? ''}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n  ${failed.length} FAILED\n` : `\n  ${checks.length} checks pass.\n`);
process.exit(failed.length ? 1 : 0);
