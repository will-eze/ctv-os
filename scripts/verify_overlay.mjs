// Unit test for the pending-overlay in prototype/sync.js.
//
// The bug it guards: a pull that lands while a local write is still in the outbox
// used to paint the server's OLDER value over the edit - the "my change didn't
// save / reverted to default" symptom. overlayPending() replays the outbox onto
// a freshly pulled document so an optimistic edit survives until the write lands.
//
// This loads sync.js in node with the browser globals stubbed, uses the real
// Sync._diff to turn a (before -> after) edit into outbox ops, then feeds the
// OLD server document back through Sync._overlayPending and asserts the edits
// are still there. No network: it exercises the pure overlay path only.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'prototype', 'sync.js'), 'utf8');

// A tiny localStorage backed by a plain object.
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const noop = () => {};
const documentStub = { addEventListener: noop, hidden: false };
const windowStub = { addEventListener: noop };

// sync.js is `const Sync = (() => {…})();` - run it with the globals it reads as
// injected parameters and hand back Sync.
const make = new Function(
  '__SUPABASE__', 'localStorage', 'document', 'window', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'WebSocket', 'location', 'history', 'crypto',
  `${code}\n; return Sync;`,
);
const Sync = make(
  null, localStorage, documentStub, windowStub, noop, noop, noop, noop,
  noop, function () {}, { origin: '', pathname: '' }, { replaceState: noop },
  { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
);

const clone = (x) => JSON.parse(JSON.stringify(x));
let pass = 0;
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`  FAIL  ${msg}\n        expected ${JSON.stringify(b)}\n        got      ${JSON.stringify(a)}`);
    process.exit(1);
  }
  pass++;
};

const ev = (over) => ({
  id: 'e1', title: 'Rugby', date: '2026-10-10', strand: 'sport', status: 'idea',
  confidence: 'estimated', venue: null, call_time: null, doors_time: null,
  start_time: null, end_time: null, brief: null, cover: null, private: false,
  kit_needed: [], prep_skip: [],
  roles: [{ id: 'r1', label: 'Camera', role: null, member: null, from: null, to: null, on_site: true }],
  prep: [], ...over,
});

const before = {
  societies: [], prep_templates: [], members: [], kit: [],
  events: [ev()],
  tasks: [
    { id: 't1', title: 'Book the room', detail: null, area: 'setup', source: 'you', owner_role: null, anchor: null, lead_days: null, due: '2026-10-01', done: false },
    { id: 't2', title: 'Scratch', detail: null, area: 'setup', source: 'you', owner_role: null, anchor: null, lead_days: null, due: null, done: false },
  ],
  boards: [{ id: 'b1', name: 'Ideas', nodes: [{ id: 'n1', x: 0, y: 0, body: 'seed', color: 'grey' }], edges: [] }],
};

// The local edits: a venue + coverage tag on the event, a role assigned, a task
// ticked, a task deleted, a brand-new event, and a note dragged on the board.
const after = clone(before);
after.events[0].venue = 'The Rec';
after.events[0].cover = 'green';
after.events[0].roles[0].member = 'alice';
after.tasks[0].done = true;
after.tasks = after.tasks.filter((t) => t.id !== 't2');
after.events.push(ev({ id: 'e2', title: 'New one', date: '2026-11-01', roles: [] }));
after.boards[0].nodes[0].x = 120;

// Turn the edit into outbox ops exactly as push() would, and stash them.
const ops = Sync._diff(before, after);
if (!ops.length) { console.error('  FAIL  the edit produced no ops'); process.exit(1); }
store['ctvos.outbox.v1'] = JSON.stringify(ops);

// A pull races in carrying the OLD server truth. Overlay the pending ops onto it.
const server = clone(before);
const shown = Sync._overlayPending(server);

const e1 = shown.events.find((e) => e.id === 'e1');
eq(e1.venue, 'The Rec', 'a pending venue edit survives the pull');
eq(e1.cover, 'green', 'a pending coverage tag survives the pull');
eq(e1.roles[0].member, 'alice', 'a pending role assignment survives the pull');
eq(shown.tasks.find((t) => t.id === 't1').done, true, 'a pending task tick survives the pull');
eq(shown.tasks.some((t) => t.id === 't2'), false, 'a pending task delete stays deleted through the pull');
eq(shown.events.some((e) => e.id === 'e2'), true, 'a pending new event is not dropped by the pull');
eq(shown.boards[0].nodes.find((n) => n.id === 'n1').x, 120, 'a pending board-note move survives the pull');

// And with an empty outbox, a pull is passed through untouched.
store['ctvos.outbox.v1'] = '[]';
const passthrough = Sync._overlayPending(clone(before));
eq(passthrough.events[0].venue, null, 'no outbox: the server document is shown as-is');

console.log(`\n  overlay: ${pass} checks pass — pending edits survive a racing pull.\n`);
