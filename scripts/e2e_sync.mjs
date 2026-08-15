// CTV OS — two browsers, one database, one year.
//
//   npm run e2e:sync
//
// scripts/e2e.mjs drives the page offline, which is where it has to be
// strongest. This is the other claim, and the one the whole rewrite was for:
// that two people with the site open are looking at the same year, and that a
// change made by one appears for the other without anybody reloading.
//
// Nothing here inspects internal state to decide whether sync "worked". It
// opens two real pages against the real project, edits in one, and waits for
// the other page's rendered DOM to say something different. If the second
// browser does not show it, it did not happen.
//
// Everything is undone afterwards, including the throwaway account, so running
// this against the live project leaves the year as it found it.

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
try {
  for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] ??= m[2].trim();
  }
} catch { /* environment only */ }

const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = env.SUPABASE_ANON_KEY;
const SEC = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SEC) {
  console.error('\n  SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY are needed.\n');
  process.exit(1);
}

const html = readFileSync(join(root, 'dist/index.html'));
if (!html.includes(URL_)) {
  console.error(`\n  dist/index.html was not built for ${URL_} — run npm run build:prototype\n`);
  process.exit(1);
}

// Served over http rather than file://, because that is how it is deployed and
// because a file:// origin is opaque — the WebSocket handshake behaves
// differently, which is exactly the part being tested.
const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}/`;

// --- A throwaway editor -----------------------------------------------------
const email = `e2e+${Date.now().toString(36)}@ctv-os.invalid`;
const password = `${Math.random().toString(36).slice(2)}Aa1!`;
const admin = (path, opts) => fetch(`${URL_}/auth/v1/${path}`, {
  headers: { apikey: SEC, Authorization: `Bearer ${SEC}`, 'Content-Type': 'application/json' },
  ...opts,
});
const account = await admin('admin/users', {
  method: 'POST',
  body: JSON.stringify({ email, password, email_confirm: true }),
}).then((r) => r.json());

// Writing the calendar now needs a per-module edit grant, not merely a session.
// Grant this throwaway editor the calendar (service key bypasses RLS to plant it;
// it cascades away with the account), so Alice can actually move an event below.
if (account?.id) {
  await fetch(`${URL_}/rest/v1/access_grants?on_conflict=user_id,module`, {
    method: 'POST',
    headers: {
      apikey: SEC, Authorization: `Bearer ${SEC}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify([{ user_id: account.id, module: 'events', can_view: true, can_edit: true }]),
  });
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    pass++;
    console.log(`  ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// `polling: 500` on every wait, never the default.
//
// waitForFunction polls on requestAnimationFrame unless told otherwise, and
// Chrome throttles rAF almost to a stop in a background tab. This suite has two
// pages open by definition, so one of them is always backgrounded — and the
// wait on that page does not time out, it hangs until puppeteer's own protocol
// timeout fires three minutes later. An interval poll keeps running whether the
// tab is visible or not, which is also the honest thing to test: Bob is not
// looking at his screen either.
const settled = (page) => page.waitForFunction(
  () => typeof Sync !== 'undefined' && Sync.status().mode !== 'connecting',
  { timeout: 20000, polling: 500 });

console.log(`\n  TWO CLIENTS, ONE YEAR  ${URL_}\n  ${'-'.repeat(70)}`);

const alice = await browser.newPage();
const bob = await browser.newPage();
await alice.setViewport({ width: 1280, height: 900 });
await bob.setViewport({ width: 1280, height: 900 });

// The event both browsers will watch, and its real title, restored at the end.
const EV = 'rugby-rec';
let original = null;

await check('both browsers load the year from the database', async () => {
  await Promise.all([
    alice.goto(site, { waitUntil: 'networkidle0' }),
    bob.goto(site, { waitUntil: 'networkidle0' }),
  ]);
  await Promise.all([settled(alice), settled(bob)]);
  const modes = await Promise.all([
    alice.evaluate(() => Sync.status().mode),
    bob.evaluate(() => Sync.status().mode),
  ]);
  if (modes.some((m) => m !== 'synced')) {
    const err = await alice.evaluate(() => Sync.status().error);
    throw new Error(`modes ${modes.join('/')} — ${err ?? 'no error reported'}`);
  }
  const counts = await Promise.all([
    alice.evaluate(() => DATA.events.length),
    bob.evaluate(() => DATA.events.length),
  ]);
  if (counts[0] !== counts[1]) throw new Error(`different years: ${counts.join(' vs ')}`);
  original = await alice.evaluate((id) => DATA.events.find((e) => e.id === id).title, EV);
  return `both synced, ${counts[0]} events each`;
});

await check('a signed-out browser is told it cannot edit', async () => {
  const said = await alice.evaluate(() => document.getElementById('sync-state').textContent.trim());
  if (said !== 'Read only') throw new Error(`status says "${said}"`);
  return '"Read only", with sign in offered beside it';
});

await check('Alice signs in through the interface', async () => {
  await alice.bringToFront();
  await alice.click('#sign');
  await alice.waitForSelector('#auth:not([hidden])');
  await alice.type('#auth-form input[name=email]', email);
  await alice.type('#auth-form input[name=password]', password);
  await alice.click('#auth-go');
  await alice.waitForFunction(() => Sync.status().signedIn === true,
    { timeout: 20000, polling: 500 });
  return await alice.evaluate(() => Sync.status().user);
});

// --- The claim --------------------------------------------------------------
// Deliberately shares no words with the original. The first version of this
// was "Rugby at the Rec — synced <hash>", which contains the old title as a
// substring, so the check for the stale title being gone could never pass.
const renamed = `Varsity fixture ${Date.now().toString(36)}`;

await check('Bob is looking at the month the event is in', async () => {
  // Put Bob on the calendar, at the event's month, BEFORE Alice touches
  // anything. An earlier version left him on Overview and asserted the new
  // title appeared in the page text — it never did, because a fixture in
  // October is not drawn on a dashboard showing August. The sync was working
  // and the test was looking at the wrong screen.
  const date = await bob.evaluate((id) => DATA.events.find((e) => e.id === id).date, EV);
  await bob.evaluate((d) => {
    document.querySelector('[data-view=calendar]').click();
    const [y, m] = d.split('-').map(Number);
    cur = { y, m: m - 1 };
    render();
  }, date);
  const shown = await bob.evaluate((t) => document.body.innerText.includes(t), original);
  if (!shown) throw new Error(`"${original}" is not on Bob's screen to begin with`);
  return `calendar at ${date.slice(0, 7)}, showing "${original}"`;
});

await check("Bob's data converges on Alice's edit", async () => {
  // Alice edits through the same path a person would: open the event, change
  // the field, blur it.
  await alice.bringToFront();
  await alice.evaluate((id) => openSheet(id, 'title'), EV);
  await alice.waitForSelector('#sheet-in [data-f=title]');
  await alice.$eval('#sheet-in [data-f=title]', (el) => { el.value = ''; });
  await alice.type('#sheet-in [data-f=title]', renamed);
  await alice.$eval('#sheet-in [data-f=title]', (el) => el.blur());

  // Bob is never touched, and never reloads.
  const t0 = Date.now();
  await bob.waitForFunction(
    (id, want) => DATA.events.find((e) => e.id === id)?.title === want,
    { timeout: 25000, polling: 250 }, EV, renamed,
  );
  const live = await bob.evaluate(() => Sync.status().live);
  return `arrived in ${((Date.now() - t0) / 1000).toFixed(1)}s over ${live ? 'the realtime socket' : 'the fallback poll'}`;
});

await check("and Bob's screen redraws to show it", async () => {
  // The claim is not that a variable changed. It is that the second person
  // sees it, so the assertion is on rendered text.
  await bob.waitForFunction(
    (want) => document.body.innerText.includes(want),
    { timeout: 15000, polling: 500 }, renamed,
  );
  const stale = await bob.evaluate((old) => document.body.innerText.includes(old), original);
  if (stale) throw new Error('the old title is still on screen beside the new one');
  return 'the calendar repainted, old title gone';
});

await check('the change is in the database, not just in two tabs', async () => {
  const row = await fetch(`${URL_}/rest/v1/events?slug=eq.${EV}&select=title`, {
    headers: { apikey: ANON },
  }).then((r) => r.json());
  if (row[0]?.title !== renamed) throw new Error(`database says "${row[0]?.title}"`);
  return 'PostgREST agrees with both browsers';
});

await check('a third arrival gets the corrected year, not the seed', async () => {
  // The seed inlined in the page still says the old title. A browser opening
  // now must show the database's answer, or the seed would quietly win on
  // every fresh visit.
  const carol = await browser.newPage();
  await carol.goto(site, { waitUntil: 'networkidle0' });
  await settled(carol);
  const title = await carol.evaluate((id) => DATA.events.find((e) => e.id === id).title, EV);
  await carol.close();
  if (title !== renamed) throw new Error(`fresh page shows "${title}"`);
  return 'loaded the edit, not the inlined seed';
});

await check('Bob still cannot edit, however much he can see', async () => {
  const n0 = await bob.evaluate(() => Sync.status().pending ?? 0);
  await bob.evaluate((id) => {
    const ev = DATA.events.find((e) => e.id === id);
    mutate('bob tries', (s) => { s.events.find((e) => e.id === id).venue = 'BOB WAS HERE'; });
  }, EV);
  await new Promise((r) => setTimeout(r, 2500));
  const row = await fetch(`${URL_}/rest/v1/events?slug=eq.${EV}&select=venue`, {
    headers: { apikey: ANON },
  }).then((r) => r.json());
  if (row[0]?.venue === 'BOB WAS HERE') throw new Error('an unauthenticated write reached the database');
  const n1 = await bob.evaluate(() => Sync.status().pending ?? 0);
  if (n1 <= n0) throw new Error('the edit was neither sent nor queued — it was lost');
  return `held locally (${n1} queued), database untouched`;
});

// --- Put the year back ------------------------------------------------------
await check('the year is restored', async () => {
  await alice.evaluate((id, title) => {
    mutate('restore', (s) => { s.events.find((e) => e.id === id).title = title; });
  }, EV, original);
  await alice.waitForFunction(() => (Sync.status().pending ?? 0) === 0,
    { timeout: 20000, polling: 500 });
  const row = await fetch(`${URL_}/rest/v1/events?slug=eq.${EV}&select=title`, {
    headers: { apikey: ANON },
  }).then((r) => r.json());
  if (row[0]?.title !== original) throw new Error(`still "${row[0]?.title}"`);
  return `back to "${original}"`;
});

await browser.close();
server.close();
if (account?.id) await admin(`admin/users/${account.id}`, { method: 'DELETE' });

console.log(
  failures.length === 0
    ? `\n  ${pass} checks pass. Two browsers, one year.\n`
    : `\n  ${pass} pass, ${failures.length} FAILED.\n`
);
process.exit(failures.length ? 1 : 0);
