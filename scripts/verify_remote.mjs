#!/usr/bin/env node
// CTV OS — verify the DEPLOYED Supabase project, not a local stand-in.
//
//   npm run verify:remote
//
// `verify:sql` executes schema.sql on PGlite. That is real Postgres, but it is
// not a real Supabase: no PostgREST, no GoTrue, and auth.role() is a shim that
// always answers 'anon'. So it can prove the schema is correct and still tell
// you nothing about whether the thing you deployed works.
//
// This connects to the actual database and, where a key is available, to the
// actual REST API, and asserts the behaviour the product depends on.
//
// Everything that writes runs inside a transaction that is rolled back, so
// verifying a live project never leaves rows behind.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env.local is written by scripts/provision_supabase.sh and gitignored.
const env = { ...process.env };
try {
  for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* fall back to the real environment */ }

// --local runs every check below against PGlite instead of a deployed project.
// It proves nothing about your Supabase — that is the whole point of the remote
// mode — but it does prove this file's SQL is valid against the real schema, so
// the first time it meets a live database it is not also the first time anyone
// has run it. `verify:sql` uses this, which is how two wrong column names in
// event_coverage were caught before a project existed.
const LOCAL = process.argv.includes('--local');
const dbUrl = env.SUPABASE_DB_URL || env.DATABASE_URL;

if (!LOCAL && !dbUrl) {
  console.error(`
  No database URL.

  Provision a project first:
      SUPABASE_ACCESS_TOKEN=sbp_xxx ./scripts/provision_supabase.sh

  Or point at one you already have — Dashboard → Project Settings → Database →
  Connection string (URI), then:
      SUPABASE_DB_URL='postgresql://...' npm run verify:remote

  To check only that this script's SQL is valid:
      node scripts/verify_remote.mjs --local
`);
  process.exit(1);
}

let client;
if (LOCAL) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  // The same shims verify_sql.mjs uses: auth.users and auth.role() exist on
  // Supabase and not on bare Postgres.
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key default gen_random_uuid());
    create or replace function auth.role() returns text as $$ select 'anon'::text $$ language sql stable;
    create or replace function auth.uid() returns uuid as $$ select null::uuid $$ language sql stable;
  `);
  await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
  client = {
    query: (sql, params) => db.query(sql, params ?? []),
    connect: async () => {},
    end: async () => db.close(),
  };
} else {
  client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
}

const results = [];
let failed = 0;
async function check(name, fn) {
  try {
    results.push(['ok  ', name, (await fn()) ?? '']);
  } catch (err) {
    failed++;
    results.push(['FAIL', name, err.message]);
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};
const one = async (sql, params) => (await client.query(sql, params)).rows[0];
const all = async (sql, params) => (await client.query(sql, params)).rows;

await client.connect();
const server = await one('select version() as v, current_database() as db');

// --- Shape ----------------------------------------------------------------
const TABLES = ['members', 'societies', 'events', 'event_roles', 'prep_items', 'prep_templates',
  'kit', 'kit_bookings', 'deliverables', 'tasks', 'playbook', 'contacts', 'ledger',
  'funding_windows', 'incidents'];
const VIEWS = ['prep_due', 'event_coverage', 'crew_clashes', 'kit_outstanding',
  'post_outstanding', 'task_due'];

await check('every table from schema.sql is on the deployed database', async () => {
  const rows = await all(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`);
  const have = rows.map((r) => r.tablename);
  const missing = TABLES.filter((t) => !have.includes(t));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return `${TABLES.length} tables`;
});

await check('every view is there and actually runs', async () => {
  for (const v of VIEWS) await client.query(`select * from ${v} limit 1`);
  return VIEWS.join(', ');
});

// --- The rules that make the data trustworthy -----------------------------
await check('RLS is enabled on every table', async () => {
  const rows = await all(
    `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  if (rows.length) throw new Error(`RLS off on: ${rows.map((r) => r.relname).join(', ')}`);
  return 'all tables';
});

await check('only plans can be deleted, never records', async () => {
  const rows = await all(
    `select tablename from pg_policies
      where schemaname = 'public' and cmd = 'DELETE' order by tablename`);
  eq([...new Set(rows.map((r) => r.tablename))], ['event_roles', 'events', 'tasks'],
     'tables with a DELETE policy');
  return 'kit, ledger, deliverables and incidents stay put';
});

await check('writing anything requires a session', async () => {
  // The deployed page carries the publishable key, so this policy set is the
  // only thing standing between a stranger with the URL and the crew list.
  const rows = await all(
    `select tablename, cmd, qual, with_check from pg_policies
      where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE')`);
  const open = rows.filter(
    (r) => !/authenticated/.test(`${r.qual ?? ''} ${r.with_check ?? ''}`));
  eq(open.map((r) => `${r.tablename}.${r.cmd}`), [], 'write policies open to anon');
  return `${rows.length} write policies, all authenticated-only`;
});

await check('safeguarding requires a real session', async () => {
  const rows = await all(
    `select qual, with_check from pg_policies
      where schemaname = 'public' and tablename = 'incidents'`);
  if (!rows.length) throw new Error('incidents has no policies at all');
  const guarded = rows.every((r) => /authenticated/.test(`${r.qual} ${r.with_check}`));
  if (!guarded) throw new Error('an incidents policy does not require authentication');
  return `${rows.length} policies, all authenticated-only`;
});

// --- Behaviour, in a transaction that is thrown away ----------------------
await check('an unassigned role reads as open, on the real database', async () => {
  await client.query('begin');
  try {
    const ev = await one(
      `insert into events (title, date, strand, status)
       values ('__ctvos_verify__', current_date + 30, 'sport', 'planned') returning id`);
    await client.query(
      `insert into event_roles (event_id, label, role, on_site) values ($1,'CAM OP','camera',true)`, [ev.id]);
    const m = await one(`insert into members (full_name, known_as) values ('__ctvos verify__','__verify__') returning id`);
    await client.query(
      `insert into event_roles (event_id, label, role, member_id, on_site)
       values ($1,'PTZ','ptz',$2,true)`, [ev.id, m.id]);

    // event_coverage keys on e.id and names the columns roles_total /
    // roles_filled / roles_open.
    const cov = await one(`select * from event_coverage where id = $1`, [ev.id]);
    eq(Number(cov.roles_total), 2, 'roles_total');
    eq(Number(cov.roles_open), 1, 'roles_open');
    eq(Number(cov.roles_filled), 1, 'roles_filled');
    eq(cov.crew_complete, false, 'crew_complete');
    return '1 of 2 open, reported by event_coverage';
  } finally {
    await client.query('rollback');
  }
});

await check('one person in two places at once is detected', async () => {
  await client.query('begin');
  try {
    const m = await one(`insert into members (full_name, known_as) values ('__ctvos verify__','__verify__') returning id`);
    const a = await one(
      `insert into events (title, date, strand, status)
       values ('__ctvos_a__', current_date + 31, 'sport', 'planned') returning id`);
    const b = await one(
      `insert into events (title, date, strand, status)
       values ('__ctvos_b__', current_date + 31, 'studio', 'planned') returning id`);
    await client.query(
      `insert into event_roles (event_id, label, role, member_id, from_time, to_time, on_site)
       values ($1,'CAM OP','camera',$2,'18:00','22:00',true)`, [a.id, m.id]);
    await client.query(
      `insert into event_roles (event_id, label, role, member_id, from_time, to_time, on_site)
       values ($1,'VISION MIX','vision_mix',$2,'20:00','23:00',true)`, [b.id, m.id]);

    const rows = await all(`select * from crew_clashes where member_id = $1`, [m.id]);
    eq(rows.length, 1, 'clashes (reported once, not twice)');
    return 'overlapping on-site roles, one row';
  } finally {
    await client.query('rollback');
  }
});

await check('an off-site role never causes a false clash', async () => {
  await client.query('begin');
  try {
    const m = await one(`insert into members (full_name, known_as) values ('__ctvos verify__','__verify__') returning id`);
    const a = await one(
      `insert into events (title, date, strand, status)
       values ('__ctvos_a__', current_date + 32, 'sport', 'planned') returning id`);
    const b = await one(
      `insert into events (title, date, strand, status)
       values ('__ctvos_b__', current_date + 32, 'studio', 'planned') returning id`);
    await client.query(
      `insert into event_roles (event_id, label, role, member_id, from_time, to_time, on_site)
       values ($1,'CAM OP','camera',$2,'18:00','22:00',true)`, [a.id, m.id]);
    // The editor's work happens tomorrow, at a desk.
    await client.query(
      `insert into event_roles (event_id, label, role, member_id, on_site)
       values ($1,'EDITOR','editor',$2,false)`, [b.id, m.id]);

    eq((await all(`select * from crew_clashes where member_id = $1`, [m.id])).length, 0, 'clashes');
    return 'editing the Rec and filming at Founders is not a conflict';
  } finally {
    await client.query('rollback');
  }
});

await check('deleting an anchored event does not fail on its tasks', async () => {
  // ON DELETE SET NULL orphaned lead_days and tripped a check constraint, which
  // failed the whole DELETE. "Order merch" made its event undeletable.
  await client.query('begin');
  try {
    const ev = await one(
      `insert into events (title, date, strand, status)
       values ('__ctvos_verify__', current_date + 33, 'freshers', 'planned') returning id`);
    const t = await one(
      `insert into tasks (title, area, anchor_event_id, lead_days)
       values ('__verify__','setup',$1,28) returning id`, [ev.id]);
    await client.query(`delete from events where id = $1`, [ev.id]);
    const task = await one(`select anchor_event_id, lead_days from tasks where id = $1`, [t.id]);
    eq(task.anchor_event_id, null, 'anchor');
    eq(task.lead_days, null, 'lead_days');
    return 'event deleted, task survives undated rather than misdated';
  } finally {
    await client.query('rollback');
  }
});

await client.end();

// --- PostgREST, the way the app would actually reach it -------------------
// This is the part PGlite cannot test at all: whether the API in front of the
// database enforces the same rules the database declares.
if (!LOCAL && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
  const api = (path) => fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
  });

  await check('the REST API serves events with the anon key', async () => {
    const res = await api('events?select=id,title&limit=1');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return `HTTP ${res.status}`;
  });

  await check('the REST API refuses incidents with the anon key', async () => {
    const res = await api('incidents?select=id&limit=1');
    const body = await res.json();
    // RLS with no matching policy returns 200 and an empty set rather than 403,
    // which is the correct behaviour and the one worth asserting: the rows are
    // not reachable, whatever the status code says.
    if (Array.isArray(body) && body.length > 0) {
      throw new Error(`anon read ${body.length} safeguarding rows`);
    }
    return `HTTP ${res.status}, no rows reachable`;
  });
} else {
  results.push(['skip', 'REST API checks',
    LOCAL ? 'there is no PostgREST in front of PGlite — remote mode only'
          : 'set SUPABASE_URL and SUPABASE_ANON_KEY to include these']);
}

console.log(`\n  ${LOCAL ? 'SQL VALIDITY (PGlite, not your project)' : 'DEPLOYED SUPABASE'} — ${server.db}`);
console.log(`  ${server.v.split(' on ')[0]}`);
console.log('  ' + '-'.repeat(72));
for (const [mark, name, detail] of results) {
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(failed
  ? `\n  ${failed} FAILED\n`
  : LOCAL
    ? `\n  ${results.length - 1} checks: the SQL in this file is valid against schema.sql.\n`
    : `\n  ${results.length} checks pass against the live project.\n`);
process.exit(failed ? 1 : 0);
