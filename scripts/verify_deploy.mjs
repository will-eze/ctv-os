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

// The one origin the artifact is allowed to reach, read out of the artifact
// itself rather than out of the config — so a build pointed at a project the
// CSP does not name fails here instead of on the deployed URL.
const cfg = (() => {
  const m = html.toString().match(/const CFG = (\{.*?\}|null);/);
  if (!m || m[1] === 'null') return null;
  try { return JSON.parse(m[1]); } catch { return null; }
})();
const dbHost = cfg ? new URL(cfg.url).host : null;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// The database host is made unresolvable for this whole run.
//
// This check is about the artifact, and the artifact must not need a database
// to be a working page — a phone at the Rec with no signal is the normal case,
// not the edge one. Depending on the real project would also make the result
// depend on whether someone happened to have seeded it: an earlier version of
// this file asserted that database requests *failed*, which quietly turned
// "the fallback works" into "the database is down" and started failing the
// moment the schema was pushed.
//
// Blocking at DNS rather than by intercepting requests, because it takes the
// WebSocket with it. It also leaves the CSP check intact: connect-src is
// enforced before name resolution, so a policy that forbade this host would
// still raise a violation here.
const cspArgs = dbHost ? [`--host-resolver-rules=MAP ${dbHost} ~NOTFOUND`] : [];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: cspArgs,
});
const page = await browser.newPage();

const violations = [];
const errors = [];
const dbNoise = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // A failed request to the database is not a defect in the artifact. It is the
  // most ordinary thing that can happen to this page — no signal at the Rec, a
  // project not yet seeded — and the page is built to carry on from the seed
  // when it happens. Chrome logs it regardless, and the browser writes that log
  // itself, so it cannot be suppressed from inside the page. Counting it as a
  // page error would mean this check could only pass against a live database,
  // which is exactly the dependency the artifact is supposed to not have.
  // Matched on the text as well as the location: a failed fetch is reported
  // against the request URL, but a failed WebSocket is reported against the
  // script that opened it, so the location alone misses exactly half of it.
  const where = m.location()?.url ?? '';
  const text = m.text();
  if (dbHost && (where.includes(dbHost) || text.includes(dbHost))) dbNoise.push(where || text);
  else errors.push(`console: ${text}`);
});
await page.evaluateOnNewDocument(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
  });
});

const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (u === url || u.startsWith('data:')) return;
  if (dbHost && new URL(u).host === dbHost) return;
  external.push(u);
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

// The counterpart to the filter above. This run reaches a database that is
// there but has no tables in it, which is indistinguishable from being offline
// — so it is the free opportunity to prove the fallback works. Every check
// below this line about rendering and interaction is running with no usable
// database behind it, and that is the point.
check('survives an unreachable database', dbNoise.length > 0 || !dbHost,
  dbHost
    ? `${dbHost} blocked at DNS, ${dbNoise.length} requests failed, page carried on`
    : 'no database configured');
check('no requests beyond the database', external.length === 0,
  external.join(' | ') || (dbHost ? `self-contained + ${dbHost}` : 'self-contained'));

// The CSP and the built page have to agree about which database exists. They
// are set in two different files by two different mechanisms — vercel.json by
// hand, the page from .env.local — and when they disagree the page loads
// perfectly and then silently cannot reach its data. That is the exact failure
// mode a CSP check is supposed to catch, so it is asserted rather than assumed.
const csp = headers['Content-Security-Policy'] ?? '';
check('the CSP names the database the page was built for',
  !dbHost || (csp.includes(`https://${dbHost}`) && csp.includes(`wss://${dbHost}`)),
  dbHost
    ? (csp.includes(`https://${dbHost}`) && csp.includes(`wss://${dbHost}`)
        ? `connect-src allows https and wss to ${dbHost}`
        : `page targets ${dbHost}, CSP connect-src does not allow it`)
    : 'no database configured — nothing to allow');

// The font is the thing a CSP most often kills, and its absence is invisible in
// a smoke test that only checks for errors.
check('Inter actually rendered', await page.evaluate(() => document.fonts.check('700 32px Inter')),
  await page.evaluate(() => getComputedStyle(document.body).fontFamily.split(',')[0]));

// Signed out, offline, on the DEPLOYED build: the access model still applies.
// This is the security boundary. A visitor with no signal (or one who blocks the
// host to try to get past the gate) must NOT fall through to the whole app the
// way "offline = show everything" used to let them. They get the public calendar
// and nothing else, read-only, and the private modules never even appear in the
// nav. The .view SECTIONS all exist in the DOM either way — they are hidden; it
// is the .nav-item list the gate controls, so that is what is asserted.
const out = await page.evaluate(() => ({
  views: document.querySelectorAll('.view').length,
  nav: [...document.querySelectorAll('.nav-item')].map((b) => b.dataset.view),
  days: document.querySelectorAll('.day[data-day]').length,
  readonly: document.body.classList.contains('is-readonly'),
}));
check('the public page rendered offline', out.views === 7 && out.days > 0,
  `${out.views} view sections, ${out.days} days`);
check('signed out + offline is calendar-only', out.nav.length === 1 && out.nav[0] === 'calendar',
  `nav: ${out.nav.join(', ') || 'none'}`);
check('no private module in the nav signed out',
  !out.nav.some((v) => ['crew', 'tasks', 'board'].includes(v)),
  'crew / to-do / board absent');
check('signed out is read-only', out.readonly, out.readonly ? 'body.is-readonly set' : 'NOT read-only');

// The field case the offline tolerance exists FOR: a crew member who signed in
// earlier and then lost signal. A stored session plus the per-user access cache
// — exactly what the app writes to localStorage after a successful sign-in —
// must restore their modules and keep the page fully editable offline, without
// the database, which stays blocked at DNS for this whole run. isAdmin in the
// cache stands in for a fully-granted account (the admin sees every module).
const UID = 'field-crew-test-uid';
await page.evaluate((uid) => {
  localStorage.setItem('ctvos.session.v1', JSON.stringify({
    access_token: 'offline.test.token', refresh_token: 'offline.test.refresh',
    expires_at: Date.now() + 3600 * 1000, user: { id: uid, email: 'crew@test' },
  }));
  localStorage.setItem('ctvos.access.v1', JSON.stringify({ uid, isAdmin: true, grants: {} }));
}, UID);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 400));

const signedIn = await page.evaluate(() => ({
  nav: document.querySelectorAll('.nav-item').length,
  readonly: document.body.classList.contains('is-readonly'),
}));
check('a signed-in crew member sees the whole app offline', signedIn.nav === 7,
  `${signedIn.nav} nav items from the cached grants`);
check('the field case stays editable offline', !signedIn.readonly,
  signedIn.readonly ? 'unexpectedly read-only' : 'editable');

// Inline handlers are the other common CSP casualty: the page looks perfect and
// nothing responds. Drive a real mutation through to localStorage — offline and
// signed in, the field crew's normal working state.
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
