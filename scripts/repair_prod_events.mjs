// Reconcile the live events table against data/year.json WITHOUT re-seeding —
// so coverage tags and any other edits made in prod are left alone.
//
//   npm run repair:events           report the difference only (read-only)
//   npm run repair:events -- --apply insert the seed events missing from prod
//
// Re-seeding would overwrite every event's columns with the file's values and
// wipe prod-only edits (the whole point of not re-seeding). This only fills the
// gaps: events that are in the seed but absent from prod are inserted; nothing
// already in prod is touched or deleted. Events public-read with the anon key;
// the insert uses the secret key, which is the credential the seed uses too.
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

const URL = env.SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY;
const SECRET = env.SUPABASE_SECRET_KEY;
const APPLY = process.argv.includes('--apply');
const year = JSON.parse(readFileSync(join(root, 'data/year.json'), 'utf8'));

const nz = (v) => (v === '' || v === undefined ? null : v);
const eventRow = (e) => ({
  slug: e.id, title: e.title, date: e.date,
  strand: e.strand || 'society', status: e.status || 'planned',
  date_confidence: e.confidence || 'estimated',
  venue: nz(e.venue), brief: nz(e.brief),
  call_time: nz(e.call_time), doors_time: nz(e.doors_time),
  start_time: nz(e.start_time), end_time: nz(e.end_time),
  kit_needed: e.kit_needed ?? [], prep_skip: e.prep_skip ?? [], cover: e.cover ?? null,
  is_private: e.private ?? false,
});

const read = await fetch(`${URL}/rest/v1/events?select=slug&limit=1000`, {
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
const prod = new Set((await read.json()).map((r) => r.slug));
const missing = year.events.filter((e) => !prod.has(e.id));

console.log(`\n  REPAIR EVENTS  file ${year.events.length}  ·  prod ${prod.size}\n  ${'-'.repeat(60)}`);
if (!missing.length) { console.log('  prod already has every seed event — nothing to do.\n'); process.exit(0); }
for (const e of missing) console.log(`  missing in prod  ${e.date}  ${e.id}  —  ${e.title}`);

if (!APPLY) {
  console.log(`\n  ${missing.length} event(s) missing. Re-run with --apply to insert them.\n`);
  process.exit(0);
}
if (!SECRET) { console.error('\n  SUPABASE_SECRET_KEY is needed to write.\n'); process.exit(1); }

const res = await fetch(`${URL}/rest/v1/events?on_conflict=slug`, {
  method: 'POST',
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  },
  body: JSON.stringify(missing.map(eventRow)),
});
if (!res.ok) { console.error(`\n  insert failed: ${res.status} ${(await res.text()).slice(0, 300)}\n`); process.exit(1); }
const back = await res.json();
console.log(`\n  inserted ${back.length} event(s). prod now: ${prod.size + back.length}.\n`);
