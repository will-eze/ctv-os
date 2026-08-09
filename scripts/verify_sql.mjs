#!/usr/bin/env node
// CTV OS — schema verification against real Postgres (PGlite/WASM).
//
// Not a mock. This executes supabase/schema.sql exactly as Supabase will, then
// asserts the behaviour the product depends on: that an unassigned role reads
// as open, that one person in two places at once is detected, that kit which
// went out and did not come back is findable, and that nothing can be deleted.
//
//   node scripts/verify_sql.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    pass++;
    console.log(`  ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    failures.push([name, err.message]);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
};

// --- Supabase shims -------------------------------------------------------
// schema.sql references auth.users and auth.role(), which exist on Supabase and
// not in bare Postgres. Shimming them is the honest way to run the real file:
// the alternative is editing the schema for the test, which would mean testing
// something other than what ships.
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid());
  create or replace function auth.role() returns text as $$ select 'anon'::text $$ language sql stable;
  create or replace function auth.uid() returns uuid as $$ select null::uuid $$ language sql stable;
`);

console.log('\n  SCHEMA\n  ' + '-'.repeat(72));

await check('schema.sql executes', async () => {
  await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
  const { rows } = await db.query(
    `select count(*)::int n from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`
  );
  return `${rows[0].n} tables`;
});

await check('schema.sql is idempotent', async () => {
  await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
  return 're-ran clean';
});

await check('every view resolves', async () => {
  const views = ['prep_due', 'event_coverage', 'crew_clashes', 'kit_outstanding', 'post_outstanding'];
  for (const v of views) await db.query(`select * from ${v} limit 0`);
  return views.join(', ');
});

// --- Seed a realistic slice ----------------------------------------------
// Rugby at the Rec, Sat 10 Oct 2026: six roles, two of them open. An arena
// night runs the same evening. Every assignment below is deliberately
// conflict-free, so each clash test creates exactly the conflict it names.
console.log('\n  BEHAVIOUR\n  ' + '-'.repeat(72));

await db.exec(`
  insert into members (id, full_name, known_as, su_member) values
    ('11111111-1111-1111-1111-111111111111', 'Destin R',  'Destin', true),
    ('22222222-2222-2222-2222-222222222222', 'Ela M',     'Ela',    true),
    ('33333333-3333-3333-3333-333333333333', 'Jack T',    'Jack',   false),
    ('44444444-4444-4444-4444-444444444444', 'Will E',    'Will',   true);

  insert into events (id, title, date, strand, status, venue, call_time, doors_time, start_time, end_time) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'Rugby at the Rec', '2026-10-10', 'sport', 'planned',
      'The Rec', '14:00', '17:00', '19:45', '22:00'),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'Arena Night 3', '2026-10-10', 'freshers', 'planned',
      'Founders Hall', '21:00', '22:00', '22:00', '23:59');

  insert into event_roles (event_id, role, label, member_id, from_time, to_time, sort_order) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'producer',   'PRODUCER',   '11111111-1111-1111-1111-111111111111', '14:00','22:00', 0),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'camera',     'GANTRY',     null,                                   '16:00','22:00', 1),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'camera',     'SU BOX',     '33333333-3333-3333-3333-333333333333', '16:00','22:00', 2),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'camera',     'ROAMING',    null,                                   '16:00','22:00', 3),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'interview',  'INTERVIEW',  '22222222-2222-2222-2222-222222222222', '17:00','19:30', 4),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'audio',      'AUDIO',      '44444444-4444-4444-4444-444444444444', '16:00','22:00', 5),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'vision_mix', 'VISION MIX', '22222222-2222-2222-2222-222222222222', '21:00','23:59', 0),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'ptz',        'PTZ',        null,                                   '21:00','23:59', 1);
`);

await check('an unassigned role reads as open', async () => {
  const { rows } = await db.query(
    `select roles_total, roles_filled, roles_open, crew_complete
       from event_coverage where id = 'aaaaaaaa-0000-0000-0000-000000000001'`
  );
  eq(rows[0].roles_total, 6, 'roles_total');
  eq(rows[0].roles_open, 2, 'roles_open');
  eq(rows[0].crew_complete, false, 'crew_complete');
  return 'Rugby at the Rec reads 4/6, 2 open';
});

await check('crew_complete only when every role is filled', async () => {
  await db.query(
    `update event_roles set member_id = '33333333-3333-3333-3333-333333333333'
      where event_id = 'aaaaaaaa-0000-0000-0000-000000000001' and member_id is null`
  );
  const { rows } = await db.query(
    `select roles_open, crew_complete from event_coverage
      where id = 'aaaaaaaa-0000-0000-0000-000000000001'`
  );
  eq(rows[0].roles_open, 0, 'roles_open');
  eq(rows[0].crew_complete, true, 'crew_complete');
  // Put it back — later checks want the gap.
  await db.query(
    `update event_roles set member_id = null
      where event_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        and label in ('GANTRY','ROAMING')`
  );
  return 'flips only at 6/6';
});

await check('two jobs on one day that do not overlap are not a clash', async () => {
  // Ela interviews at the Rec until 19:30 and vision mixes from 21:00. Both
  // events, same day, same person — and correctly silent.
  const { rows } = await db.query(`select count(*)::int n from crew_clashes`);
  eq(rows[0].n, 0, 'clash rows');
  return 'Rec 17:00–19:30 then Founders 21:00 is a legal night';
});

await check('one person in two places at once is detected', async () => {
  await db.query(
    `update event_roles set to_time = '23:00' where label = 'INTERVIEW'`
  );
  const { rows } = await db.query(
    `select known_as, label_a, event_a_title, label_b, event_b_title from crew_clashes`
  );
  eq(rows.length, 1, 'clash count');
  eq(rows[0].known_as, 'Ela', 'who');
  return `${rows[0].known_as}: ${rows[0].label_a} overlaps ${rows[0].label_b}`;
});

await check('a clash is reported once, not twice', async () => {
  const { rows } = await db.query(`select count(*)::int n from crew_clashes`);
  // Without the r1.id < r2.id guard this is 2 — the self-join finds (a,b) and
  // (b,a) — and the crew view would double-count every conflict it shows.
  eq(rows[0].n, 1, 'clash rows');
  return 'r1.id < r2.id holds';
});

await check('a clash within a single event is reported too', async () => {
  // Being down for gantry and roaming at the same hour is the same failure as
  // being at two venues, and is the easier one to create by accident. This is
  // a deliberate behaviour, not a side effect: the view does not filter on
  // event_id, so intra-event overlaps surface like any other.
  await db.query(
    `update event_roles set member_id = '33333333-3333-3333-3333-333333333333'
      where label = 'ROAMING'`
  );
  const { rows } = await db.query(
    `select count(*)::int n from crew_clashes where event_a = event_b`
  );
  eq(rows[0].n, 1, 'intra-event clashes');
  await db.query(`update event_roles set member_id = null where label = 'ROAMING'`);
  return 'Jack cannot be on SU box and roaming at once';
});

await check('an off-site role never clashes', async () => {
  // Found by seeding the real year: Ela edits Arena Night 1 and also works the
  // freshers fair that day. The editor role has no hours because the work is
  // tomorrow, so an all-day reading would flag a conflict that does not exist.
  // Reset the conflict the previous check created, so a non-zero result here
  // can only be caused by the off-site row.
  await db.query(`update event_roles set to_time = '19:30' where label = 'INTERVIEW'`);
  const { rows: baseline } = await db.query(`select count(*)::int n from crew_clashes`);
  eq(baseline[0].n, 0, 'baseline clashes');

  await db.query(`
    insert into event_roles (event_id, role, label, member_id, on_site, sort_order)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'editor', 'EDITOR',
            '22222222-2222-2222-2222-222222222222', false, 6)
  `);
  const { rows } = await db.query(`select count(*)::int n from crew_clashes`);
  eq(rows[0].n, 0, 'clash rows');
  return 'Ela can edit the Rec and still be at Founders that night';
});

await check('an off-site role still counts toward coverage', async () => {
  // It is off-site, not optional: an unassigned editor is still an open role.
  const { rows } = await db.query(
    `select roles_total, roles_open from event_coverage
      where id = 'aaaaaaaa-0000-0000-0000-000000000001'`
  );
  eq(rows[0].roles_total, 7, 'roles_total');
  eq(rows[0].roles_open, 2, 'roles_open');
  await db.query(`delete from event_roles where label = 'EDITOR'`);
  return '7 roles now, still 2 open';
});

await check('an untimed on-site role still clashes', async () => {
  await db.query(`update event_roles set from_time = null, to_time = null where label = 'INTERVIEW'`);
  const { rows } = await db.query(`select count(*)::int n from crew_clashes`);
  // coalesce treats a missing time as all day, so an untimed role errs toward
  // being reported. Silence has to mean "checked and clear", never "unknown".
  eq(rows[0].n, 1, 'clash rows');
  await db.query(`update event_roles set from_time='17:00', to_time='19:30' where label='INTERVIEW'`);
  return 'missing times read as all day, not as no clash';
});

await check('prep due dates count back from the event', async () => {
  await db.query(`
    insert into prep_items (event_id, label, lead_days, owner_role) values
      ('aaaaaaaa-0000-0000-0000-000000000001', 'Event planner + risk assessment to Helen', 14, 'Head of Tech'),
      ('aaaaaaaa-0000-0000-0000-000000000001', 'Press passes / AAA with SU Sport', 7, 'Head of Sport')
  `);
  const { rows } = await db.query(
    `select label, due_on::text from prep_due
      where event_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by lead_days desc`
  );
  eq(rows[0].due_on, '2026-09-26', 'T-14 from 10 Oct');
  eq(rows[1].due_on, '2026-10-03', 'T-7 from 10 Oct');
  return 'T-14 → 26 Sep, T-7 → 3 Oct';
});

await check('moving an event moves its prep', async () => {
  await db.query(
    `update events set date = '2026-10-17' where id = 'aaaaaaaa-0000-0000-0000-000000000001'`
  );
  const { rows } = await db.query(
    `select due_on::text from prep_due
      where event_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by lead_days desc limit 1`
  );
  eq(rows[0].due_on, '2026-10-03', 'T-14 from 17 Oct');
  await db.query(`update events set date='2026-10-10' where id='aaaaaaaa-0000-0000-0000-000000000001'`);
  return 'due dates are derived, never stored';
});

await check('kit that went out and did not come back is findable', async () => {
  await db.exec(`
    insert into kit (id, name, category, asset_tag) values
      ('bbbbbbbb-0000-0000-0000-000000000001', 'SDI reel 50m', 'cable', 'CTV-C-014'),
      ('bbbbbbbb-0000-0000-0000-000000000002', 'SD card #4',   'media', 'CTV-M-004');
    insert into kit_bookings (kit_id, event_id, booked_for, out_at, out_by, back_at) values
      ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','2026-10-10','2026-10-10 14:02+01','11111111-1111-1111-1111-111111111111', null),
      ('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-10-10','2026-10-10 14:02+01','11111111-1111-1111-1111-111111111111', '2026-10-11 01:40+01');
  `);
  const { rows } = await db.query(`select name, taken_by from kit_outstanding`);
  eq(rows.length, 1, 'outstanding count');
  eq(rows[0].name, 'SDI reel 50m', 'which item');
  return '1 of 2 back — the reel is still out';
});

await check('an edit past its turnaround reads as late', async () => {
  // Due dates are relative to today so the check holds whenever it is run —
  // a hard-coded 2026 date would flip from passing to failing as the real
  // calendar moves past it.
  await db.query(`
    insert into deliverables (event_id, title, kind, shot_on, due_on) values
      ('aaaaaaaa-0000-0000-0000-000000000001', 'Rec interviews',  'interview_clip',
        current_date - 4, current_date - 3),
      ('aaaaaaaa-0000-0000-0000-000000000001', 'Rec highlights',  'highlight',
        current_date - 4, current_date + 3)
  `);
  const { rows } = await db.query(
    `select title, late, days_late from post_outstanding order by due_on`
  );
  eq(rows.length, 2, 'unposted deliverables');
  eq(rows[0].late, true, 'overdue one is late');
  eq(rows[0].days_late, 3, 'days late');
  eq(rows[1].late, false, 'future one is not late');
  return `${rows[0].title} 3 days late, ${rows[1].title} not yet due`;
});

await check('posting a deliverable takes it off the list', async () => {
  await db.query(
    `update deliverables set posted_at = now() where title = 'Rec interviews'`
  );
  const { rows } = await db.query(`select count(*)::int n from post_outstanding`);
  eq(rows[0].n, 1, 'still outstanding');
  return 'shot-and-not-out is the only thing the post view asks';
});

console.log('\n  THE TO-DO LIST\n  ' + '-'.repeat(72));

await check('a task can be dated by a fixed date', async () => {
  await db.query(`
    insert into tasks (slug, title, area, source, owner_role, due_on)
    values ('nasta-fee', 'Pay the NaSTA membership fee', 'nasta', 'VIa',
            'Station Manager', '2027-01-29')
  `);
  const { rows } = await db.query(
    `select effective_due::text from task_due where slug = 'nasta-fee'`
  );
  eq(rows[0].effective_due, '2027-01-29', 'effective_due');
  return 'fixed 29 Jan';
});

await check('a task anchored to an event moves with it', async () => {
  // "Order merch" is T−28 from the start of freshers. Not one date this year
  // is confirmed, so this is the common case, not the exotic one.
  await db.query(`
    insert into tasks (slug, title, area, source, owner_role, anchor_event_id, lead_days)
    values ('merch', 'Order merch', 'setup', 'Ia', 'Station Manager',
            'aaaaaaaa-0000-0000-0000-000000000001', 28)
  `);
  const before = await db.query(`select effective_due::text from task_due where slug='merch'`);
  eq(before.rows[0].effective_due, '2026-09-12', 'T−28 from 10 Oct');

  await db.query(`update events set date = '2026-10-17'
                   where id = 'aaaaaaaa-0000-0000-0000-000000000001'`);
  const after = await db.query(`select effective_due::text from task_due where slug='merch'`);
  eq(after.rows[0].effective_due, '2026-09-19', 'T−28 from 17 Oct');

  await db.query(`update events set date='2026-10-10'
                   where id='aaaaaaaa-0000-0000-0000-000000000001'`);
  return 'event +7d → task +7d';
});

await check('a task cannot be dated two ways at once', async () => {
  try {
    await db.query(`
      insert into tasks (slug, title, area, due_on, anchor_event_id, lead_days)
      values ('bad', 'Ambiguous', 'setup', '2026-10-01',
              'aaaaaaaa-0000-0000-0000-000000000001', 7)
    `);
  } catch (err) {
    if (!/tasks_one_dating/.test(err.message)) throw new Error(`wrong constraint: ${err.message}`);
    return 'tasks_one_dating rejects it';
  }
  throw new Error('a task with both a fixed date and an anchor was accepted');
});

await check('lead_days without an anchor is rejected', async () => {
  try {
    await db.query(`insert into tasks (slug, title, area, lead_days)
                    values ('bad2', 'Lead with nothing to lead', 'setup', 14)`);
  } catch (err) {
    if (!/tasks_lead_needs_anchor/.test(err.message)) throw new Error(err.message);
    return 'tasks_lead_needs_anchor rejects it';
  }
  throw new Error('lead_days with no anchor was accepted');
});

await check('deleting an anchored event is not blocked by its tasks', async () => {
  await db.exec(`
    insert into events (id, title, date, strand, status)
    values ('aaaaaaaa-0000-0000-0000-000000000003', 'Throwaway', '2026-11-01', 'admin', 'idea');
    insert into tasks (slug, title, area, anchor_event_id, lead_days)
    values ('orphan', 'Anchored to something doomed', 'setup',
            'aaaaaaaa-0000-0000-0000-000000000003', 7);
  `);
  await db.query(`delete from events where id = 'aaaaaaaa-0000-0000-0000-000000000003'`);
  const { rows } = await db.query(
    `select effective_due, overdue from task_due where slug = 'orphan'`
  );
  eq(rows[0].effective_due, null, 'effective_due');
  eq(rows[0].overdue, null, 'overdue');
  const { rows: lead } = await db.query(`select lead_days from tasks where slug = 'orphan'`);
  eq(lead[0].lead_days, null, 'lead_days');
  return 'event deleted, task survives undated rather than misdated';
});

console.log('\n  SAFETY\n  ' + '-'.repeat(72));

await check('RLS is on for every table', async () => {
  const { rows } = await db.query(
    `select tablename from pg_tables
      where schemaname = 'public' and rowsecurity = false`
  );
  eq(rows.map((r) => r.tablename), [], 'tables without RLS');
  return 'all tables';
});

await check('only plans can be deleted, never records', async () => {
  // The year was reconstructed from a handover, so a fixture that was never
  // real has to be removable. A kit booking or a ledger line is a record of
  // something that happened and must not be.
  //
  // event_roles joined the list when the store moved to Postgres. Removing a
  // role has always been an offered action; against localStorage it was a
  // shorter array, and against a shared database it has to be a DELETE or the
  // role reappears on the next pull. It is a slot in a plan, not a record.
  // access_grants joined the list with role-based access: revoking a grant is a
  // real DELETE the admin performs, and a grant is a decision, not a record.
  // prep_items joined it when per-event prep became editable in the sheet: a
  // prep step is a plan like a role, and removing one has to be a DELETE or it
  // returns on the next pull. The reusable rule lives in prep_templates.
  const { rows } = await db.query(
    `select tablename from pg_policies
      where schemaname = 'public' and cmd = 'DELETE' order by tablename`
  );
  eq(rows.map((r) => r.tablename), ['access_grants', 'event_roles', 'events', 'prep_items', 'tasks'],
     'tables with a DELETE policy');
  return 'kit, ledger, deliverables and incidents stay put';
});

await check('writing anything requires a session', async () => {
  // Reads of the calendar are open with the publishable key; writes are not. The
  // key ships inside the deployed page, so an unguessable URL protects nothing.
  // A write is protected if it requires an authenticated session, or admin, or
  // an edit grant on a private module — never if it is open to anon.
  const { rows } = await db.query(
    `select tablename, cmd, qual, with_check from pg_policies
      where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE')`
  );
  const open = rows.filter(
    (r) => !/authenticated|is_admin|can_edit/.test(`${r.qual ?? ''} ${r.with_check ?? ''}`)
  );
  eq(open.map((r) => `${r.tablename}.${r.cmd}`), [], 'write policies open to anon');
  return `${rows.length} write policies, all gated by session, admin or grant`;
});

await check('the public calendar stays readable without a session', async () => {
  // Shutting anon out of writes must not shut the station out of looking at the
  // year. The public tables — events and everything the calendar hangs off —
  // read with the publishable key. The private modules (crew, tasks), the
  // account tables and incidents are the deliberate exceptions.
  const gated = new Set(['incidents', 'members', 'tasks',
    'profiles', 'access_grants', 'invites', 'admins']);
  const { rows } = await db.query(
    `select tablename, qual from pg_policies
      where schemaname = 'public' and cmd = 'SELECT'`
  );
  const shut = rows.filter((r) => !gated.has(r.tablename) && r.qual !== 'true');
  eq(shut.map((r) => r.tablename), [], 'public tables anon cannot read');
  return `${rows.filter((r) => !gated.has(r.tablename)).length} public tables readable with the key`;
});

await check('crew and the to-do list are private, gated by a grant', async () => {
  // The two modules the station manager marked private. Their read policies are
  // not open: they resolve through can_view(), so only the admin or a granted
  // account sees crew details or the to-do list.
  const { rows } = await db.query(
    `select tablename, qual from pg_policies
      where schemaname = 'public' and cmd = 'SELECT'
        and tablename in ('members', 'tasks') order by tablename`
  );
  eq(rows.map((r) => r.tablename), ['members', 'tasks'], 'both have a SELECT policy');
  for (const r of rows) {
    if (!/can_view/.test(r.qual ?? '')) throw new Error(`${r.tablename} read is not grant-gated`);
  }
  return 'members and tasks resolve through can_view()';
});

await check('incidents is not readable with the anon role', async () => {
  const { rows } = await db.query(
    `select qual from pg_policies where tablename = 'incidents' and cmd = 'SELECT'`
  );
  if (!rows.length) throw new Error('no SELECT policy on incidents at all');
  if (!/authenticated/.test(rows[0].qual)) {
    throw new Error(`safeguarding readable by anon: ${rows[0].qual}`);
  }
  return 'requires a real session, unlike every other table';
});

await check('cancelling an event hides it from coverage but keeps the row', async () => {
  await db.query(
    `update events set status = 'cancelled', cancelled_reason = 'overcrowded — see IIf'
      where id = 'aaaaaaaa-0000-0000-0000-000000000002'`
  );
  const { rows: cov } = await db.query(
    `select count(*)::int n from event_coverage where id = 'aaaaaaaa-0000-0000-0000-000000000002'`
  );
  const { rows: raw } = await db.query(
    `select cancelled_reason from events where id = 'aaaaaaaa-0000-0000-0000-000000000002'`
  );
  eq(cov[0].n, 0, 'rows in coverage');
  eq(raw[0].cancelled_reason, 'overcrowded — see IIf', 'reason retained');
  return 'out of the calendar, still in the record';
});

await check('a cancelled event stops causing clashes', async () => {
  // Create a live clash first, so this proves cancellation clears it rather
  // than passing because there was nothing to clear.
  await db.query(`update events set status = 'planned'
                   where id = 'aaaaaaaa-0000-0000-0000-000000000002'`);
  await db.query(`update event_roles set to_time = '23:00' where label = 'INTERVIEW'`);
  const { rows: before } = await db.query(`select count(*)::int n from crew_clashes`);
  eq(before[0].n, 1, 'clashes before cancelling');

  await db.query(`update events set status = 'cancelled'
                   where id = 'aaaaaaaa-0000-0000-0000-000000000002'`);
  const { rows: after } = await db.query(`select count(*)::int n from crew_clashes`);
  eq(after[0].n, 0, 'clashes after cancelling');
  return '1 clash before, 0 after — Ela is free again';
});

console.log(
  failures.length === 0
    ? `\n  ${pass} checks pass.\n`
    : `\n  ${pass} pass, ${failures.length} FAILED.\n`
);
process.exit(failures.length === 0 ? 0 : 1);
