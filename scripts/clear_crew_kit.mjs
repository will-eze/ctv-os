// CTV OS — clear the crew roster and the kit register from the deployed project.
//
//   npm run clear:crew-kit
//
// A one-off the station manager asked for: wipe the previous year's crew and
// kit so a new committee starts clean. It is deliberately narrow — it touches
// exactly two tables and nothing else.
//
//   - members: deleting a person nulls the roles they held (event_roles.member_id
//     is ON DELETE SET NULL), so the calendar keeps its events and just shows
//     those slots open again. Nobody is assigned by default anyway, so on the
//     seeded year this is usually a no-op on roles.
//   - kit: deleting a piece cascades its kit_bookings (kit_id is ON DELETE
//     CASCADE). events.kit_needed is jsonb keyed by kit slug and is left as-is;
//     it simply points at kit that no longer exists until re-entered.
//
// It does NOT touch events, tasks, societies or anything else. This clears the
// live database only; data/year.json (the seed) is left intact on purpose, so
// the offline prototype and the test suites still have crew and kit to exercise.
// Re-running `npm run seed` would repopulate both tables from the seed.
//
// This goes through PostgREST with the secret (service_role) key rather than a
// direct Postgres connection, the same channel scripts/seed_supabase.mjs uses —
// no separate DB password needed. The service key bypasses RLS, which is why the
// DELETE lands regardless of who is signed in. Pass --yes to skip the prompt.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
try {
  for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* environment only */ }

const url = (env.SUPABASE_URL || '').replace(/\/$/, '');
const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('\n  Need SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.\n');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function count(table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=id`, {
    headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  const range = res.headers.get('content-range') || '*/0';   // e.g. "0-0/21"
  return Number(range.split('/')[1] || 0);
}

// PostgREST refuses an unfiltered DELETE; id=not.is.null matches every row.
async function wipe(table) {
  const res = await fetch(`${url}/rest/v1/${table}?id=not.is.null`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=representation' },
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return (await res.json()).length;
}

const members = await count('members');
const kit = await count('kit');
console.log(`\n  Live project ${env.SUPABASE_PROJECT_REF || ''}: ${members} crew, ${kit} kit item${kit === 1 ? '' : 's'}.`);

if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) =>
    rl.question('  Delete ALL crew and kit from the live database? Type "yes" to confirm: ', r));
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('  Aborted — nothing was changed.\n');
    process.exit(0);
  }
}

const k = await wipe('kit');        // kit first; its bookings cascade
const m = await wipe('members');    // then crew; their roles null out
console.log(`\n  Done — deleted ${m} crew and ${k} kit. Crew and kit are clean.\n`);
