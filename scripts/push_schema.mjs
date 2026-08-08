// CTV OS — push the generated migration to the deployed Supabase project.
//
//   npm run db:push
//
// Needs SUPABASE_ACCESS_TOKEN (a personal access token, sbp_...). Neither the
// publishable key nor the secret key can create a table: both authenticate to
// PostgREST, which deliberately has no endpoint that runs DDL. This goes to the
// Management API instead.
//
// scripts/provision_supabase.sh does this too, as part of creating a project
// from nothing. This is the other half of that: the project already exists and
// only the schema is missing, which is the common case after the first time.
//
// Pushes supabase/migrations/*.sql rather than supabase/schema.sql, because the
// migration is generated from the schema and `npm run verify:sql` fails if the
// two have drifted. What gets deployed is what was verified.

import { readFileSync, readdirSync } from 'node:fs';
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
  console.error(`
  SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are needed.

  The token is a personal access token from
  https://supabase.com/dashboard/account/tokens — it starts sbp_, and it is the
  only credential that can create tables. Revoke it when you are done.
`);
  process.exit(1);
}

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

const dir = join(root, 'supabase/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
if (!files.length) {
  console.error('  no migrations — run npm run db:migration first\n');
  process.exit(1);
}

console.log(`\n  PUSH SCHEMA  ${REF}\n  ${'-'.repeat(64)}`);

for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  process.stdout.write(`  ${f}  ${text.split('\n').length} lines ... `);
  await sql(text);
  console.log('ok');
}

// Read back what is actually there, rather than trusting that the push worked.
// The count is the cheap version; npm run verify:remote is the real one.
const tables = await sql(
  `select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`);
const views = await sql(
  `select table_name from information_schema.views
    where table_schema = 'public' order by table_name`);
const policies = await sql(
  `select count(*)::int as n from pg_policies where schemaname = 'public'`);

const names = tables.map((t) => t.table_name);
const viewNames = views.map((v) => v.table_name);
const tableOnly = names.filter((n) => !viewNames.includes(n));

console.log(`
  ${'-'.repeat(64)}
  ${tableOnly.length} tables, ${viewNames.length} views, ${policies[0].n} policies.

  ${tableOnly.join(', ')}

  next:  npm run seed          load data/year.json
         npm run verify:remote assert the deployed database behaves
`);
