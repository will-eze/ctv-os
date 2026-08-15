// One-off: remove the 12 estimated September placeholder events from the live
// project, after the official Freshers' Week programme was seeded in their place.
//
//   npm run clear:placeholders
//
// The seed upserts events by slug and deliberately never deletes — that is what
// protects an event someone added in-app from being wiped by the next --force.
// So the old placeholders survive a re-seed and have to be removed surgically,
// by their known slugs, exactly like `npm run clear:crew-kit` clears the roster.
//
// Deleting an event cascades its roles, prep and deliverables (ON DELETE CASCADE)
// and nulls any task anchor (ON DELETE SET NULL). The seeded to-dos were already
// re-pointed to the official successors in data/year.json, so none of them point
// at these slugs and none are affected. Needs SUPABASE_ACCESS_TOKEN (sbp_...).
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

const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = env.SUPABASE_PROJECT_REF;
if (!PAT || !REF) {
  console.error('\n  SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are needed (see db:push).\n');
  process.exit(1);
}

const PLACEHOLDERS = [
  'hub-setup', 'committee-1', 'ww-fri', 'ww-sat', 'ww-sun',
  'freshers-fair', 'sports-fair', 'arena-1', 'arena-2', 'arena-3', 'arena-4',
  'camera-training',
];

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${body.slice(0, 600)}`);
  try { return JSON.parse(body); } catch { return null; }
}

console.log(`\n  CLEAR PLACEHOLDERS  ${REF}\n  ${'-'.repeat(64)}`);

const list = PLACEHOLDERS.map((s) => `'${s}'`).join(', ');
// Report what is actually there before removing it, so the run is auditable.
const present = await sql(`select slug, title from events where slug in (${list}) order by slug`);
if (!present.length) {
  console.log('  none of the placeholder slugs are present — nothing to do.\n');
  process.exit(0);
}
for (const r of present) console.log(`  will delete  ${r.slug.padEnd(16)} ${r.title}`);

await sql(`delete from events where slug in (${list})`);

const [{ count }] = await sql('select count(*)::int as count from events');
console.log(`  ${'-'.repeat(64)}`);
console.log(`  deleted ${present.length} placeholder event(s). events now: ${count}.\n`);
if (count !== 102) {
  console.error(`  NOTE: expected 102 events after the freshers seed, the DB has ${count}.\n`);
}
