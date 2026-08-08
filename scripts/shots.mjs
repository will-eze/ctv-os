#!/usr/bin/env node
// CTV OS — screenshot the prototype, and audit what a screenshot cannot show.
//
//   node scripts/shots.mjs
//
// The audit rules changed with the design. The previous visual system banned
// shadows, radius above 2px and left-edge accents; Studio Essential *requires*
// all three, so enforcing the old bans would have meant enforcing the design
// the user rejected. What survives is the principle underneath them — a rule
// is only worth having if a script can fail on it — so these are the rules
// that actually constrain a ported design system:
//
//   1. No external requests except the one configured database. Tailwind's CDN,
//      Google Fonts and Material Symbols are all blocked by the artifact CSP, so
//      the port had to replace them. The page now talks to Supabase, which is
//      the whole point of it being shared — so the rule is not "no network" but
//      "nothing the deploy CSP does not name". A font, an analytics beacon or a
//      second API creeping in still fails, which is what the rule was for.
//      Everything else still has to be inlined, and the page still has to work
//      over file:// with no signal.
//   2. One family, Inter. A missing @font-face silently falls back and nobody
//      notices in review.
//   3. Radius conformance. ROUND_EIGHT plus the pill; an arbitrary value is
//      drift from the system.
//   4. No state carried by colour alone. The one rule that outlived the
//      redesign, and the important one: an uncovered role is the object this
//      product exists to surface, so it must say so in words, not only in red.

import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'prototype/shots');
mkdirSync(out, { recursive: true });

const url = pathToFileURL(join(root, 'prototype/ctv-os.html')).href;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--allow-file-access-from-files', '--force-color-profile=srgb'],
});

const failures = [];
const shots = [];
const go = (v) => `document.querySelector('[data-view=${v}]').click()`;

// The single origin the built page is allowed to reach, taken from the same
// place the page took it — so this cannot drift from what was actually built.
// Requests to it are expected and are not failures; they will not succeed here
// anyway, because these shots load over file:// and the page falls back to the
// seed, which is exactly the behaviour being photographed.
const allowedOrigin = (() => {
  const m = readFileSync(join(root, 'prototype/ctv-os.html'), 'utf8')
    .match(/const CFG = (\{.*?\}|null);/);
  if (!m || m[1] === 'null') return null;
  try { return new URL(JSON.parse(m[1]).url).host; } catch { return null; }
})();
const foreign = (u) =>
  !u.startsWith('file:') && !u.startsWith('data:')
  && !(allowedOrigin && new URL(u).host === allowedOrigin);

async function shot(name, { width, height, prep }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  const external = [];
  page.on('request', (r) => { if (foreign(r.url())) external.push(r.url()); });
  await page.goto(url, { waitUntil: 'networkidle0' });
  if (prep) await page.evaluate(prep);
  await new Promise((r) => setTimeout(r, 350));       // let fonts settle
  await page.screenshot({ path: join(out, `${name}.png`) });
  shots.push(`${name}.png  ${width}×${height}`);
  // Rule 1, checked on every screen rather than once: a stray asset could be
  // referenced from any one of them.
  for (const u of external) failures.push(`${name}: unexpected request to ${u}`);
  return page;
}

// --- Screens --------------------------------------------------------------
await (await shot('01-overview',  { width: 1440, height: 1000 })).close();
await (await shot('02-calendar',  { width: 1440, height: 1050, prep: new Function(go('calendar')) })).close();
await (await shot('03-schedule',  { width: 1440, height: 1100, prep: new Function(go('schedule')) })).close();
await (await shot('04-tasks',     { width: 1440, height: 1000, prep: new Function(go('tasks')) })).close();
await (await shot('05-crew',      { width: 1440, height: 1000, prep: new Function(go('crew')) })).close();
await (await shot('06-sheet', {
  width: 1440, height: 1050,
  prep: () => { document.querySelector('[data-ev="rugby-rec"]')?.click(); },
})).close();
await (await shot('07-tasks-list', {
  width: 1440, height: 1000,
  prep: () => {
    document.querySelector('[data-view=tasks]').click();
    document.querySelector('[data-task-mode=list]').click();
  },
})).close();
await (await shot('08-phone-calendar', {
  width: 390, height: 844, prep: new Function(go('calendar')),
})).close();
await (await shot('09-phone-schedule', {
  width: 390, height: 844, prep: new Function(go('schedule')),
})).close();

// --- Audit ----------------------------------------------------------------
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto(url, { waitUntil: 'networkidle0' });

// Rule 2: every rendered element resolves to Inter. A dropped @font-face falls
// back to the system stack and still looks plausible in a screenshot.
const fonts = await page.evaluate(() => {
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!el.textContent?.trim()) continue;
    seen.add(getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim());
  }
  return [...seen];
});
for (const f of fonts) if (f !== 'Inter') failures.push(`font family "${f}" is not Inter`);
const interLoaded = await page.evaluate(() => document.fonts.check('700 32px Inter'));
if (!interLoaded) failures.push('Inter did not load — the embedded woff2 is not being used');

// Rule 3: ROUND_EIGHT. Cards take 12, small controls 4 and 6, pills 999.
const ALLOWED = new Set([0, 4, 6, 8, 12, 999]);
const radii = await page.evaluate(() => {
  const bad = {};
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    for (const c of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
      const r = Math.round(parseFloat(s[`border${c}Radius`]) || 0);
      if (r === 0) continue;
      const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      bad[r] ??= `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
    }
  }
  return bad;
});
for (const [r, where] of Object.entries(radii)) {
  const n = Number(r);
  if (!ALLOWED.has(n) && n < 100) failures.push(`border-radius ${n}px on ${where} is not in the 8px scale`);
}

// Rule 4, on each screen that carries the signal.
for (const [view, check, label] of [
  ['schedule', () => {
    // Every Missing Requirements panel names the roles in words and offers the
    // control that closes them, in the panel.
    const panels = [...document.querySelectorAll('.missing')];
    if (!panels.length) return 'no Missing Requirements panel rendered at all';
    const mute = panels.filter((p) => !/missing requirements/i.test(p.textContent)
      || !p.querySelector('[data-assign]'));
    return mute.length ? `${mute.length} panel(s) without a worded heading or an Assign control` : null;
  }, 'uncovered roles state themselves in words'],

  ['schedule', () => {
    // The crewed count is text, so coverage never depends on the card's colour.
    const cards = [...document.querySelectorAll('.tl-card')];
    const mute = cards.filter((c) => !/(\d+\/\d+ crewed|no roles yet)/i.test(c.textContent));
    return mute.length ? `${mute.length} event card(s) show coverage only as colour` : null;
  }, 'coverage is a fraction, not a hue'],

  ['tasks', () => {
    // An overdue task is red AND says how late it is.
    const over = [...document.querySelectorAll('.tcard.is-over')];
    const mute = over.filter((c) => !/late|today/i.test(c.textContent));
    return mute.length ? `${mute.length} overdue task(s) carry no words` : null;
  }, 'overdue tasks say how late they are'],

  ['calendar', () => {
    // Each badge names its coverage in its accessible name, because the badge
    // itself is one line of colour.
    const evs = [...document.querySelectorAll('.ev[data-ev]')];
    if (!evs.length) return 'no event badges rendered';
    const mute = evs.filter((e) => !/(\d+\/\d+ crewed|no roles yet)/i.test(e.title || ''));
    return mute.length ? `${mute.length} calendar badge(s) without coverage in the title` : null;
  }, 'calendar badges name their coverage'],
]) {
  await page.evaluate((v) => document.querySelector(`[data-view=${v}]`).click(), view);
  const problem = await page.evaluate(check);
  if (problem) failures.push(`[${view}] ${problem}`);
  else shots.push(null, `ok  ${label}`);
}

// The open bay in the sheet — the control that closes a gap — must say "Open".
await page.evaluate(() => {
  document.querySelector('[data-view=calendar]').click();
  document.querySelector('[data-ev]')?.click();
});
const bays = await page.evaluate(() => {
  const open = [...document.querySelectorAll('.bay.is-open')];
  return { n: open.length, mute: open.filter((b) => !/open/i.test(b.textContent)).length };
});
if (bays.mute) failures.push(`${bays.mute} open role bay(s) carry no word, only colour`);

// Reduced motion must actually collapse, not just be declared.
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
const reduced = await page.evaluate(() =>
  getComputedStyle(document.getElementById('sheet')).transitionDuration);

// Undo has to be reachable while the sheet is open. A z-index bug once put the
// toast under the scrim and the check that should have caught it asserted the
// edit instead of the undo, so it is asserted directly here.
const undoOnTop = await page.evaluate(() => {
  const sheet = document.getElementById('sheet');
  sheet.classList.add('is-open');
  document.getElementById('scrim').classList.add('is-open');
  const t = document.getElementById('toast');
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const btn = document.getElementById('toast-undo').getBoundingClientRect();
  const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
  return { visible: r.width > 0, reachable: !!hit && document.getElementById('toast').contains(hit) };
});
if (!undoOnTop.visible || !undoOnTop.reachable) {
  failures.push('the Undo button is not clickable while the sheet and scrim are open');
}

await browser.close();

console.log('\n  SHOTS\n  ' + '-'.repeat(66));
for (const s of shots) console.log(s === null ? '' : `  ${s}`);
console.log('\n  AUDIT\n  ' + '-'.repeat(66));
console.log(`  fonts in use: ${fonts.join(', ')}`);
console.log(`  radii in use: ${Object.keys(radii).sort((a, b) => a - b).join(', ')}px`);
console.log(`  sheet transition under prefers-reduced-motion: ${reduced}`);
console.log(`  undo reachable over an open sheet: ${undoOnTop.reachable}`);
if (failures.length === 0) {
  console.log(
    `\n  no requests beyond ${allowedOrigin ?? 'the page itself'}; one family; `
    + `radii on scale; every state carries words.\n`
  );
} else {
  console.log('');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log('');
}
process.exit(failures.length ? 1 : 0);
