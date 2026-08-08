// CTV OS — verify the DEPLOYED API, through the door the browser uses.
//
//   npm run verify:api
//
// verify_sql.mjs proves the schema is valid Postgres. verify_remote.mjs proves
// the deployed database enforces it, over a direct connection. Neither is what
// the page talks to: the page talks to PostgREST with a publishable key that is
// printed inside it, and that is the surface a stranger with the URL also has.
// So this exercises exactly that surface, from outside.
//
// The important assertion is not "the write was rejected". Row level security
// does not reject an UPDATE; it filters the rows the statement can see, and a
// PATCH that matches nothing returns 204 exactly like a PATCH that worked. An
// earlier version of this check read that 204 and called it a pass. Everything
// below asks what actually changed.
//
// Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY. The secret key
// is used only to create a throwaway account and to plant one safeguarding row,
// both of which are removed again — never to stand in for a user.

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

// --- Plumbing ---------------------------------------------------------------
async function api(path, { key = ANON, token, method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token || key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, json, text };
}

// `return=representation` makes RLS legible: it returns the rows the statement
// actually touched, so zero rows is zero rows and not an ambiguous 204.
const touched = (r) => (Array.isArray(r.json) ? r.json.length : null);

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
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

console.log(`\n  DEPLOYED API  ${URL_}\n  ${'-'.repeat(70)}`);

// --- A throwaway account ----------------------------------------------------
// Created and destroyed inside this run, so nothing is left behind and no real
// password has to be stored anywhere for the suite to work.
const testEmail = `verify+${Date.now().toString(36)}@ctv-os.invalid`;
const testPw = `${Math.random().toString(36).slice(2)}Aa1!`;

const made = await fetch(`${URL_}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: SEC, Authorization: `Bearer ${SEC}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: testEmail, password: testPw, email_confirm: true }),
}).then((r) => r.json());

const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: testEmail, password: testPw }),
}).then((r) => r.json());
const TOKEN = signIn.access_token;

async function cleanup() {
  if (made?.id) {
    await fetch(`${URL_}/auth/v1/admin/users/${made.id}`, {
      method: 'DELETE',
      headers: { apikey: SEC, Authorization: `Bearer ${SEC}` },
    });
  }
}

// --- Reading ----------------------------------------------------------------
console.log('\n  ANYONE WITH THE LINK CAN READ\n  ' + '-'.repeat(70));

await check('the year is readable with the publishable key', async () => {
  const r = await api('events?select=slug,title,date_confidence');
  eq(r.status, 200, 'status');
  if (!r.json.length) throw new Error('no events — has the seed run?');
  const estimated = r.json.filter((e) => e.date_confidence === 'estimated').length;
  return `${r.json.length} events, ${estimated} still marked date-to-confirm`;
});

await check('open roles are visible, and are the point', async () => {
  const r = await api('event_coverage?select=title,roles_total,roles_open');
  eq(r.status, 200, 'status');
  const open = r.json.reduce((n, e) => n + Number(e.roles_open), 0);
  if (open === 0) throw new Error('no open roles at all — the seed filled them');
  return `${open} open roles across ${r.json.length} events`;
});

// --- Private pages ----------------------------------------------------------
console.log('\n  BUT CREW AND THE TO-DO LIST ARE PRIVATE\n  ' + '-'.repeat(70));

await check('crew is not readable without a grant', async () => {
  // The station manager marked crew private. Anon sees nothing, and so does a
  // signed-in account that has not been granted the crew module.
  const anon = (await api('members?select=id')).json;
  const mine = (await api('members?select=id', { token: TOKEN })).json;
  eq(Array.isArray(anon) ? anon.length : -1, 0, 'members visible to anon');
  eq(Array.isArray(mine) ? mine.length : -1, 0, 'members visible to an ungranted account');
  return 'members hidden from anon and ungranted accounts';
});

await check('the to-do list is not readable without a grant', async () => {
  const anon = (await api('tasks?select=slug')).json;
  const mine = (await api('tasks?select=slug', { token: TOKEN })).json;
  eq(Array.isArray(anon) ? anon.length : -1, 0, 'tasks visible to anon');
  eq(Array.isArray(mine) ? mine.length : -1, 0, 'tasks visible to an ungranted account');
  return 'tasks hidden from anon and ungranted accounts';
});

// --- Writing ----------------------------------------------------------------
console.log('\n  BUT NOT WRITE\n  ' + '-'.repeat(70));

const target = 'ww-fri';
const before = (await api(`events?slug=eq.${target}&select=title,venue`)).json[0];

await check('an anonymous UPDATE changes nothing', async () => {
  const r = await api(`events?slug=eq.${target}`, {
    method: 'PATCH', body: { title: 'HACKED' }, prefer: 'return=representation',
  });
  eq(touched(r), 0, 'rows updated');
  const after = (await api(`events?slug=eq.${target}&select=title`)).json[0];
  eq(after.title, before.title, 'title after an anonymous write');
  return `0 rows touched, title still "${before.title.slice(0, 28)}…"`;
});

await check('an anonymous DELETE removes nothing', async () => {
  const n0 = (await api('events?select=slug')).json.length;
  const r = await api('events?slug=eq.results-day', {
    method: 'DELETE', prefer: 'return=representation',
  });
  eq(touched(r), 0, 'rows deleted');
  const n1 = (await api('events?select=slug')).json.length;
  eq(n1, n0, 'event count');
  return `0 rows deleted, still ${n1} events`;
});

await check('an anonymous INSERT is refused outright', async () => {
  const r = await api('events', {
    method: 'POST',
    body: { slug: `intruder-${Date.now()}`, title: 'Intruder', date: '2027-01-01' },
    prefer: 'return=representation',
  });
  // INSERT is the one that does error: WITH CHECK has no rows to filter, so
  // Postgres raises rather than quietly writing nothing.
  if (r.status < 400) throw new Error(`insert succeeded with status ${r.status}`);
  return `${r.status}, ${(r.json?.message ?? '').slice(0, 44)}`;
});

// --- With a session ---------------------------------------------------------
console.log('\n  A SIGNED-IN EDITOR CAN\n  ' + '-'.repeat(70));

await check('signing in with the publishable key works', async () => {
  if (!TOKEN) throw new Error(`no access token: ${JSON.stringify(signIn).slice(0, 120)}`);
  return `session for ${testEmail}`;
});

await check('an UPDATE with a session actually lands', async () => {
  const mark = `Rec — verified ${Date.now().toString(36)}`;
  const r = await api(`events?slug=eq.${target}`, {
    token: TOKEN, method: 'PATCH', body: { venue: mark }, prefer: 'return=representation',
  });
  eq(touched(r), 1, 'rows updated');
  const after = (await api(`events?slug=eq.${target}&select=venue`)).json[0];
  eq(after.venue, mark, 'venue after a signed-in write');
  // Put it back, so running this suite does not edit the real year.
  await api(`events?slug=eq.${target}`, {
    token: TOKEN, method: 'PATCH', body: { venue: before.venue },
  });
  return '1 row changed, then restored';
});

await check('filling an open role is what the session is for', async () => {
  const open = (await api('event_roles?member_id=is.null&select=id,label&limit=1')).json[0];
  if (!open) throw new Error('no open role to fill');
  // Crew is private now, so read a member with the secret key (bypasses RLS)
  // rather than the anon key, which sees no members at all.
  const me = (await api('members?select=id,known_as&limit=1', { key: SEC })).json[0];
  const r = await api(`event_roles?id=eq.${open.id}`, {
    token: TOKEN, method: 'PATCH', body: { member_id: me.id }, prefer: 'return=representation',
  });
  eq(touched(r), 1, 'rows updated');
  await api(`event_roles?id=eq.${open.id}`, {
    token: TOKEN, method: 'PATCH', body: { member_id: null },
  });
  const back = (await api(`event_roles?id=eq.${open.id}&select=member_id`)).json[0];
  eq(back.member_id, null, 'role reopened');
  return `${open.label} filled by ${me.known_as}, then reopened`;
});

await check('an event can be created and deleted again', async () => {
  const slug = `verify-${Date.now().toString(36)}`;
  const made_ = await api('events', {
    token: TOKEN, method: 'POST',
    body: { slug, title: 'Verification event', date: '2027-06-01', strand: 'admin' },
    prefer: 'return=representation',
  });
  eq(touched(made_), 1, 'rows inserted');
  const gone = await api(`events?slug=eq.${slug}`, {
    token: TOKEN, method: 'DELETE', prefer: 'return=representation',
  });
  eq(touched(gone), 1, 'rows deleted');
  return 'created, then deleted — the two tables that allow it';
});

await check('a kit booking cannot be deleted, even with a session', async () => {
  // The rule the product is built on: a record of something that happened is
  // not removable. There is no DELETE policy on kit_bookings at all.
  const r = await api('kit_bookings?id=not.is.null', {
    token: TOKEN, method: 'DELETE', prefer: 'return=representation',
  });
  eq(touched(r), 0, 'kit bookings deleted');
  return '0 rows — no DELETE policy exists to match';
});

// --- Safeguarding -----------------------------------------------------------
console.log('\n  SAFEGUARDING IS STRICTER THAN EVERYTHING ELSE\n  ' + '-'.repeat(70));

await check('an incident is invisible to anyone without a session', async () => {
  // Planted with the secret key, because the anon key cannot write one and the
  // check is worthless against an empty table: `[]` would pass either way.
  const planted = await api('incidents', {
    key: SEC, method: 'POST',
    body: { summary: '__verify__ do not keep', happened_on: '2026-08-08' },
    prefer: 'return=representation',
  });
  if (!Array.isArray(planted.json) || !planted.json.length) {
    throw new Error(`could not plant a row: ${planted.text.slice(0, 160)}`);
  }
  const id = planted.json[0].id;
  try {
    const anon = await api('incidents?select=id');
    eq(touched(anon), 0, 'incidents visible to anon');
    const authed = await api(`incidents?id=eq.${id}&select=id`, { token: TOKEN });
    eq(touched(authed), 1, 'incidents visible to a signed-in user');
    return 'planted 1 row: anon sees 0, a session sees 1';
  } finally {
    await api(`incidents?id=eq.${id}`, { key: SEC, method: 'DELETE' });
  }
});

// --- Realtime ---------------------------------------------------------------
console.log('\n  REALTIME\n  ' + '-'.repeat(70));

await check('the Realtime socket accepts a subscription', async () => {
  const ws = new WebSocket(
    `${URL_.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`);
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply within 10s')), 10000);
    ws.onopen = () => ws.send(JSON.stringify({
      topic: 'realtime:public', event: 'phx_join', ref: '1',
      payload: {
        config: {
          postgres_changes: [{ event: '*', schema: 'public', table: 'events' }],
        },
        access_token: TOKEN,
      },
    }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event === 'phx_reply') { clearTimeout(timer); resolve(msg); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('socket error')); };
  });
  ws.close();
  eq(reply.payload?.status, 'ok', 'join status');
  return 'joined realtime:public for postgres_changes on events';
});

await cleanup();

console.log(
  failures.length === 0
    ? `\n  ${pass} checks pass against the live project.\n`
    : `\n  ${pass} pass, ${failures.length} FAILED.\n`
);
process.exit(failures.length ? 1 : 0);
