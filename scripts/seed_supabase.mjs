// CTV OS — load data/year.json into the deployed Supabase project.
//
//   npm run seed            load into an empty database, refuse otherwise
//   npm run seed -- --force replace what is there
//
// Uses the secret key, which bypasses RLS. That is the point: schema.sql
// requires an authenticated session for every write, and the seed is not a
// user. The key is read from .env.local and never leaves this process.
//
// Idempotent by construction. Everything with a natural name is written by
// slug; roles, prep items and deliverables have no name of their own, so their
// ids are derived from a hash of the event slug and their position. Re-running
// the seed produces byte-identical ids rather than a second copy of the year.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

// --- Config ----------------------------------------------------------------
const env = { ...process.env };
try {
  for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] ??= m[2].trim();
  }
} catch { /* environment only */ }

const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !KEY) {
  console.error(`
  SUPABASE_URL and SUPABASE_SECRET_KEY are needed.

  Both live in .env.local. The secret key is the one marked "service role" in
  the dashboard under Project Settings -> API keys. It bypasses row level
  security, so it belongs here and nowhere near the browser.
`);
  process.exit(1);
}

// --- HTTP ------------------------------------------------------------------
async function rest(path, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${opts.method || 'GET'} ${path}\n  ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const upsert = (table, rows, on) =>
  rows.length
    ? rest(`${table}?on_conflict=${on}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows),
      })
    : [];

// Deterministic uuid from a stable string. Not a real v5 (no namespace), but it
// has the only property that matters here: the same input always gives the same
// id, so seeding twice does not double the crew list.
//
// Roles do not use this — they carry their own `id` in data/year.json, so that
// the copy of the year inlined into the page and the copy in the database agree
// about which role is which. A client that has never reached the network still
// names the same roles the database does, and its queued edits land on them
// instead of creating duplicates. prep items and deliverables are not editable
// from any screen, so position is a good enough name for them.
function uuidFrom(s) {
  const h = createHash('sha1').update(s).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '5' + h.slice(13, 16),
          ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
          h.slice(20, 32)].join('-');
}

const nz = (v) => (v === '' || v === undefined ? null : v);

// --- Go --------------------------------------------------------------------
const year = JSON.parse(readFileSync(join(root, 'data/year.json'), 'utf8'));
const step = (n, s) => process.stdout.write(`  ${n}  ${s}\n`);

console.log(`\n  SEED  ${URL_}\n  ${'-'.repeat(66)}`);

const existing = await rest('events?select=id&limit=1');
if (existing.length && !FORCE) {
  console.error(`
  The database already has events in it.

  Re-running the seed would overwrite whatever the station has edited since.
  If that is what you want:  npm run seed -- --force
`);
  process.exit(1);
}

// societies ------------------------------------------------------------------
const socs = await upsert('societies', year.societies.map((s) => ({
  slug: s.id,
  name: s.name,
  standing_terms: nz(s.standing_terms),
  cautions: nz(s.cautions),
  charge_policy: nz(s.charge_policy),
})), 'slug');
const socId = new Map(socs.map((s) => [s.slug, s.id]));
step('1/9', `${socs.length} societies`);

// members --------------------------------------------------------------------
// Deliberately NOT seeded. On the manager's instruction the deployed app starts
// with an empty crew roster (and an empty kit locker below): a new committee is
// never handed last year's people or gear, and adds both in-app instead. The
// seed in data/year.json is left intact — the offline prototype and the test
// suites still exercise crew and kit from it — but it is not pushed here. This
// seed is purely additive for crew/kit: it never creates them and never deletes
// what the manager has entered live, so re-running it is safe. An existing live
// roster from an earlier seed is removed once with `npm run clear:crew-kit`.
// Roles carry member_id NULL anyway (nobody is assigned by default), so no
// member lookup is needed to seed them.
const memId = new Map();
step('2/9', '0 members — crew is added in-app, not seeded');

// prep templates -------------------------------------------------------------
// Replaced outright rather than upserted. Their uniqueness is enforced by two
// partial indexes (one for a named strand, one for the universal ones), and
// PostgREST's on_conflict cannot name a partial index. Nothing edits these from
// any screen — they are the lead-time rules the handover states, copied into a
// table — so replacing them is both safe and the honest description of what
// re-seeding a set of templates means.
await rest('prep_templates?id=not.is.null', { method: 'DELETE' });
const tpl = await rest('prep_templates', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify(year.prep_templates.map((p, i) => ({
    // "*" in the document means every strand; NULL is how the table says it.
    strand: p.strand === '*' ? null : p.strand,
    label: p.label,
    detail: nz(p.detail),
    lead_days: p.lead_days ?? 0,
    owner_role: nz(p.owner_role),
    sort_order: i,
  }))),
});
const universal = tpl.filter((t) => t.strand === null).length;
step('3/9', `${tpl.length} prep templates — ${universal} apply to every strand`);

// events ---------------------------------------------------------------------
const evs = await upsert('events', year.events.map((e) => ({
  slug: e.id,
  title: e.title,
  date: e.date,
  strand: e.strand,
  status: e.status,
  // The whole reason events are movable: this says how much the date is worth.
  date_confidence: e.confidence ?? 'estimated',
  venue: nz(e.venue),
  call_time: nz(e.call_time),
  doors_time: nz(e.doors_time),
  start_time: nz(e.start_time),
  end_time: nz(e.end_time),
  brief: nz(e.brief),
  society_id: e.society ? (socId.get(e.society) ?? null) : null,
  kit_needed: e.kit_needed ?? [],
})), 'slug');
const evId = new Map(evs.map((e) => [e.slug, e.id]));
step('4/9', `${evs.length} events`);

// event roles ----------------------------------------------------------------
// THE primary object. An `event_roles` row with member_id NULL is the thing
// every screen in the product is built to surface, so getting these in — and
// getting the NULLs to stay NULL — is the part of the seed that matters.
const roles = [];
for (const e of year.events) {
  (e.roles ?? []).forEach((r, i) => {
    if (!r.id) throw new Error(`role ${i} on ${e.id} has no id — see data/year.json`);
    roles.push({
      id: r.id,
      event_id: evId.get(e.id),
      label: r.label,
      role: nz(r.role),
      member_id: r.member ? (memId.get(r.member) ?? null) : null,
      from_time: nz(r.from),
      to_time: nz(r.to),
      on_site: r.on_site !== false,
      sort_order: i,
    });
  });
}
await upsert('event_roles', roles, 'id');
const open = roles.filter((r) => !r.member_id).length;
step('5/9', `${roles.length} roles — ${open} of them open`);

// prep items and deliverables ------------------------------------------------
const prep = [];
const delivs = [];
for (const e of year.events) {
  (e.prep ?? []).forEach((p, i) => prep.push({
    id: uuidFrom(`prep:${e.id}:${i}`),
    event_id: evId.get(e.id),
    label: p.label,
    detail: nz(p.detail),
    lead_days: p.lead_days ?? 0,
    owner_role: nz(p.owner_role),
    sort_order: i,
  }));
  (e.deliverables ?? []).forEach((d, i) => delivs.push({
    id: uuidFrom(`deliv:${e.id}:${i}`),
    event_id: evId.get(e.id),
    title: d.title,
    kind: d.kind ?? 'interview_clip',
    nasta_category: nz(d.nasta_category),
  }));
}
await upsert('prep_items', prep, 'id');
await upsert('deliverables', delivs, 'id');
step('6/9', `${prep.length} prep items, ${delivs.length} deliverables`);

// tasks ----------------------------------------------------------------------
const tasks = await upsert('tasks', year.tasks.map((t, i) => ({
  slug: t.id,
  title: t.title,
  detail: nz(t.detail),
  area: t.area,
  source: nz(t.source),
  owner_role: nz(t.owner_role),
  // tasks_one_dating: a fixed date or an anchor, never both.
  due_on: t.anchor ? null : nz(t.due),
  anchor_event_id: t.anchor ? (evId.get(t.anchor) ?? null) : null,
  lead_days: t.anchor ? t.lead_days : null,
  done_on: t.done ? new Date().toISOString().slice(0, 10) : null,
  academic_year: year.academic_year,
  sort_order: i,
})), 'slug');
step('7/9', `${tasks.length} tasks`);

// kit ------------------------------------------------------------------------
// Not seeded either — same reason as crew above. The locker starts empty on the
// live project and the manager fills it in-app. events.kit_needed in the seed
// points at kit slugs that will not exist until entered; that is harmless (it is
// jsonb with no foreign key) and simply shows as unresolved until the kit is
// added. Additive like crew: never created here, never deleted here.
step('8/9', '0 kit items — the locker is filled in-app, not seeded');

// board -----------------------------------------------------------------------
// The private brainstorming canvas. Keyed by slug (the client id in
// data/year.json), like the rest. Notes and links resolve to their board's
// uuid, so the boards are seeded first and their ids looked up for the children.
const boards = await upsert('boards', (year.boards ?? []).map((b, i) => ({
  slug: b.id, name: b.name, sort_order: i,
})), 'slug');
const boardIdBySlug = Object.fromEntries(
  (await rest('boards?select=id,slug')).map((b) => [b.slug, b.id])
);
const nodes = [], edges = [];
for (const b of year.boards ?? []) {
  (b.nodes ?? []).forEach((n, i) => nodes.push({
    slug: n.id, board_id: boardIdBySlug[b.id],
    x: n.x ?? 0, y: n.y ?? 0, body: n.body ?? '', color: n.color ?? 'grey', sort_order: i,
  }));
  (b.edges ?? []).forEach((e) => edges.push({
    slug: e.id, board_id: boardIdBySlug[b.id], from_node: e.from, to_node: e.to,
  }));
}
await upsert('board_nodes', nodes, 'slug');
await upsert('board_edges', edges, 'slug');
step('9/9', `${boards.length} boards, ${nodes.length} notes, ${edges.length} links`);

// --- What the database now says --------------------------------------------
// Read it back through the view the interface reads, rather than trusting the
// inserts. The number that matters is the open-role count: if the seed had
// quietly filled them, every screen would look finished and be wrong.
const coverage = await rest('event_coverage?select=roles_open');
const totalOpen = coverage.reduce((n, r) => n + Number(r.roles_open), 0);

console.log(`
  ${'-'.repeat(66)}
  ${evs.length} events, ${roles.length} roles, ${tasks.length} tasks.
  event_coverage reports ${totalOpen} open roles across ${coverage.length} events.
`);

if (totalOpen !== open) {
  console.error(`  MISMATCH: seeded ${open} open roles, the view sees ${totalOpen}.\n`);
  process.exit(1);
}
