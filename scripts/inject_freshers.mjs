// One-off: fold the official Freshers' Week 2026 programme (data/freshers-2026-
// events.csv, extracted from thesubath.com) into data/year.json as real events,
// replacing the handful of estimated September placeholders that stood in for it.
//
// These are the *official* dates now, so they come in as confidence:"fixed".
// Nobody is assigned (roles:[]) — the same "nobody by default" rule the seed
// follows — and every event starts with no colour tag (cover omitted). CTV then
// tags which ones it is covering from the calendar.
//
// Idempotent enough to re-run: it drops every event whose id begins "fw26-" plus
// the known September placeholders before re-adding, so a second run does not
// duplicate. Run once with:  node scripts/inject_freshers.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csv = readFileSync(join(root, 'data/freshers-2026-events.csv'), 'utf8');
const year = JSON.parse(readFileSync(join(root, 'data/year.json'), 'utf8'));

// --- CSV: a small quoted-field parser (venues carry commas) ----------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const [header, ...lines] = parseCsv(csv);
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

// --- Times: "10pm" / "10:30am" / "12pm" / "2am" -> "HH:MM" (or null) --------
function toTime(s) {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1]; const min = m[2] || '00'; const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

// --- Strand: the calendar's own vocabulary ---------------------------------
function strandFor(name, arena) {
  const n = name.toLowerCase();
  if (arena) return 'ball';                       // the big night events
  if (n.includes('sport')) return 'sport';
  if (n.includes('societ') || n.includes('groups fair')) return 'society';
  return 'freshers';
}

// --- Slug: unique per event (names repeat across days) ----------------------
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const seen = new Set();
function idFor(name, date) {
  const base = `fw26-${slugify(name)}-${date.slice(5).replace('-', '')}`;
  let id = base, n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

const events = lines.filter((r) => r[col.name]?.trim()).map((r) => {
  const name = r[col.name].trim();
  const date = r[col.date].trim();
  const arena = /^y/i.test(r[col.arena_night] || '');
  const start = toTime(r[col.start]);
  const end = toTime(r[col.end]);
  const venue = (r[col.venue] || '').trim() || null;
  const brief = (r[col.description] || '').trim() || null;
  const ev = {
    id: idFor(name, date),
    title: name,
    date,
    strand: strandFor(name, arena),
    status: 'planned',
    confidence: 'fixed',
    venue,
    brief,
    roles: [],
  };
  if (start) ev.start_time = start;
  if (end) ev.end_time = end;
  return ev;
});

// --- Splice: drop the September placeholders + any prior fw26 import --------
const PLACEHOLDERS = new Set([
  'hub-setup', 'committee-1', 'ww-fri', 'ww-sat', 'ww-sun',
  'freshers-fair', 'sports-fair', 'arena-1', 'arena-2', 'arena-3', 'arena-4',
  'camera-training',
]);
const before = year.events.length;
year.events = year.events.filter(
  (e) => !e.id.startsWith('fw26-') && !PLACEHOLDERS.has(e.id)
);
const removed = before - year.events.length;

// The freshers-prep to-do list hangs off these placeholders by lead time, so
// simply nulling their anchors would strip the dates off 30-odd tasks and break
// the whole lead-time engine for freshers. Re-point each removed placeholder to
// its official successor instead, so those tasks stay dated (and move if the real
// event moves). ww-fri was the freshers kickoff; the Arrivals Party is now. A
// placeholder with no listed successor (CTV-internal setup) falls back to null.
const SUCCESSOR = {
  'ww-fri': 'fw26-arrivals-party-0919',   // Welcome Weekend N1 -> first freshers night
  'ww-sat': 'fw26-arrivals-party-0919',
  'ww-sun': 'fw26-show-your-colours-arena-night-0920',
  'freshers-fair': 'fw26-freshers-fair-0925',
  'sports-fair': 'fw26-sports-fair-0923',
};
const newIds = new Set(events.map((e) => e.id));
let repointed = 0, nulled = 0;
for (const t of year.tasks || []) {
  if (t.anchor && !year.events.some((e) => e.id === t.anchor)) {
    const to = SUCCESSOR[t.anchor];
    if (to && newIds.has(to)) { t.anchor = to; repointed++; }
    else { t.anchor = null; t.lead_days = undefined; nulled++; }
  }
}

year.events.push(...events);
year.events.sort((a, b) => a.date.localeCompare(b.date)
  || (a.start_time || '').localeCompare(b.start_time || ''));

writeFileSync(join(root, 'data/year.json'), JSON.stringify(year, null, 2) + '\n');
console.log(`removed ${removed} placeholder/prior events, added ${events.length} freshers events`);
console.log(`re-pointed ${repointed} task anchor(s) to successors, nulled ${nulled}`);
console.log(`total events now: ${year.events.length}`);
