# CLAUDE.md — CTV OS

Internal operating system for **CampusTV**, the student TV station at the
University of Bath. Built from `Handover Document - CampusTV station manager
2026.pdf` (in this directory — read it before making product decisions). That
PDF and `CampusTV_Knowledge_Summary.txt` are **gitignored**: real internal
material, not ours to publish. They are on the station manager's machine, not
in a clone. `data/year.json` is the derived, shareable form.

Sits beside the user's other projects: **Cue** (broadcast presentation
software) and **Prism** (camera training). Sibling repo `../JSS Organiser` is
the reference for how this user likes things built.

---

## ⚠️ Read this first

### 1. The Stitch redesign — APPLIED

The user rejected the original visual design ("I don't like the design, use
this stitch design instead") in favour of Google Stitch's **CampusTV Studio
Hub** (project `1770876369783682792`). **The port is done.** The prototype is
now Studio Essential end to end; `DESIGN.md` is the record of how, and of the
two places the port deliberately departs from Stitch.

All seven screens plus the token set are on disk in `stitch/` as HTML + PNG:

| File | Screen | Ported as |
|---|---|---|
| `studio-dashboard.*` | Studio Overview — live player, Next Up, activity | **Overview** |
| `broadcast-calendar.*` | Month grid, filters, detail card | **Calendar** |
| `event-schedule.*` | Week strip, timeline cards, "Missing Requirements" | **Schedule** |
| `production-tasks*.*` | Kanban board + list view | **To do** |
| `crew-directory.*` | Person cards, assignment, comms | **Crew** |
| `gear-locker.*` | Inventory stats, filter tabs, item cards | *not built — no kit data* |
| `design-system.json` | *Studio Essential* — Material token set | tokens in `template.html` |

Two of Stitch's screens had no data behind them and were adapted rather than
copied: the dashboard's **live video player** (there is no stream) became the
uncovered-role list, which is the right thing in the biggest slot anyway; the
**Gear Locker** has no `kit` rows in `data/year.json`, so it is not built — see
"Not built" below.

**Fetching more from Stitch:** the MCP is registered
(`https://stitch.googleapis.com/mcp`, header `X-Goog-Api-Key`) but Claude Code
**cannot load its tool schemas** — it fails with `can't resolve reference
#/$defs/ScreenInstance`. Call it with plain JSON-RPC over `curl` instead. It is
a *stateless* server, so no session id is needed; `initialize` is optional and
you can POST `tools/call` directly. Useful tools: `list_screens`, `get_screen`,
`list_design_systems`, `generate_screen_from_text`, `edit_screens`.
`scripts/` has no wrapper for this on purpose — it needs the API key.

**Studio Essential in one paragraph:** light only, Inter throughout, 8px
radius, 260px fixed sidebar on `#f2f3ff`, page `#faf8ff`, white cards with a
1px `#c0c9be` border and a soft `0 4px 12px rgba(0,0,0,0.05)` shadow, dark green
primary `#004421` with `#1d5c35` containers, red `#ba1a1a` / `#ffdad6` for
errors. Corporate and calm rather than broadcast-technical — explicitly a move
*away* from the original direction, so do not reintroduce tally semantics,
Archivo/Martian Mono, or the dark theme.

**Constraints that held, and still hold:**
- **The monthly calendar stays.** Stated explicitly: *"don't lose the monthly
  calendar feature."* Stitch's Event Schedule is a week strip only, so the month
  grid was drawn from scratch in Studio Essential's language. Monday-first, not
  Stitch's Sunday-first — this is a UK academic calendar.
- The *look* was replaced; the *behaviour and data model* were not. Drag to
  move, sheet editing, delete, undo, localStorage, export, the lead-time engine,
  clash detection and the 56-task to-do list all survived and are all still
  covered by `npm run e2e`.
- The original tally aesthetic was **rejected**. Do not defend or reinstate it.

### 2. `prototype/ctv-os.html` is GENERATED — never edit it directly

```
prototype/template.html  +  data/year.json  +  prototype/fonts/Inter.woff2
        └── scripts/build_prototype.py ──▶ prototype/ctv-os.html  (~200 KB)
```

Edit `template.html`, then `npm run build:prototype`. Editing `ctv-os.html` by
hand loses the change on the next build.

### 3. Nothing in the 2026/27 year is a confirmed date

The handover states exactly **two**: National Television Day is 21 November,
and welcome weekend is the Friday–Sunday before freshers. Everything else was
inferred from phrases like *"Rugby at the Rec in October"* and is marked
`"confidence": "estimated"` in `data/year.json`, rendering as *date to confirm*.

This is why events are movable and deletable, and why every deadline is
**derived, never stored** — correcting one date corrects everything hanging off
it. Do not "helpfully" harden these dates.

Committee names in `data/year.json` are the handover's names plus placeholders.
Not real. Replace before anything ships.

---

## Layout

| Path | What it is |
|---|---|
| `PRODUCT.md` | Strategy: primary object, anti-references, principles |
| `DESIGN.md` | Studio Essential: the port, the two deliberate departures, measured contrast |
| `stitch/` | The seven Stitch screens as HTML + PNG, and `design-system.json` |
| `supabase/schema.sql` | 15 tables, 7 views. Reasoning lives in the comments |
| `data/year.json` | 31 events, 56 tasks, societies, members, prep templates |
| `scripts/add_tasks.py` | Source of the to-do list; regenerates `tasks` in year.json |
| `prototype/template.html` | The prototype source |
| `prototype/sync.js` | Multi-client sync: diff, PostgREST, auth, Realtime |
| `scripts/seed_supabase.mjs` | Loads `year.json` into the deployed database |
| `prototype/shots/` | Screenshots, regenerated by `npm run shots` |

## Commands

```bash
npm install
npm run build:prototype   # template + data -> ctv-os.html
npm run tasks             # rebuild the to-do list into data/year.json
npm run verify            # 21 token-drift + 31 contrast + 29 schema + 11 deploy
npm run e2e               # 41 interaction checks in real Chrome, offline
npm run e2e:sync          # 10 checks: TWO browsers against the live project
npm run shots             # 9 screenshots + the design-system audit
npm run db:migration      # regenerate the Supabase migration from schema.sql
npm run db:provision      # create the Supabase project + push schema (needs a PAT)
npm run db:push           # push the migration (needs SUPABASE_ACCESS_TOKEN)
npm run seed              # load data/year.json into the DEPLOYED database
npm run verify:api        # 12 RLS/Realtime checks through PostgREST, live
npm run verify:remote     # behavioural checks over a direct Postgres connection
npm run deploy            # build -> dist/, then vercel deploy --prod
```

`verify:sql` runs `schema.sql` on **real Postgres** (PGlite/WASM), not a mock.

`verify:contrast` does two jobs. It compares all 21 palette tokens back to
`stitch/design-system.json` — the CSS hand-copies them because the CSP blocks
Tailwind, and a hand-copied palette rots quietly — and it measures every
foreground/background pair the UI actually paints, compositing the ones set with
opacity. Re-run it after any token change; the ratios in DESIGN.md come from it.

`shots` enforces what replaced the old bans: no requests to any origin except
the one configured database, Inter only, radii on the 8px scale, and no state
carried by colour alone. That first rule reads the origin out of the built page
rather than out of a config, so it cannot drift from what shipped.

Chrome path is hardcoded in `scripts/e2e.mjs` and `scripts/shots.mjs`:
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

The prototype's "now" is the hardcoded constant `TODAY = '2026-08-07'` in
`template.html`. Several e2e assertions depend on it.

## How sync works

`prototype/sync.js` — inlined into the page by the build, never fetched.

The document stayed; the unit of *writing* became the row. `mutate()` already
cloned the whole year before every change so undo could restore it, and that
clone is the other half of a diff. Comparing before against after yields the
handful of rows that actually moved, and only those are written. **All thirteen
`mutate()` call sites got multi-client sync without being touched**, and an undo
is just the same diff applied the other way.

- **Reading** pulls all eight tables in full, every time. A `updated_at`
  watermark is the obvious optimisation and it is wrong: it cannot see a DELETE,
  so a fixture somebody else removed would sit on your calendar until you
  reloaded. A year is ~31 events and ~56 tasks — about 60 KB. Revisit when that
  stops being true.
- **Live** is a Realtime WebSocket, spoken as raw Phoenix frames. Losing it
  degrades to a 20s poll, not to stale data.
- **Offline** is a first-class state, not an error. Edits go to an outbox in
  `localStorage` and replay on the next successful write.
- **No `supabase-js`.** The CSP forbids external scripts and the audit forbids
  external requests other than the database; what is actually needed is six
  verbs over `fetch` and four WebSocket message shapes.
- **Identity.** Events and tasks are addressed by slug, because that is what
  `data/year.json` calls them and what the export has to round-trip. Roles are
  addressed by uuid and **those uuids live in `data/year.json`** — so the copy
  of the year inlined in the page and the copy in the database name the same
  roles, and a client that has never reached the network still queues edits that
  land on the right rows instead of duplicating them.

Built with no `.env.local`, `supabase_config()` returns `null` and the build
produces exactly the local-only prototype that came before. That is not a
degraded mode: it is what `npm run e2e` drives, from a `file://` URL.

## Product decisions that are settled

Do not relitigate these — the user answered them directly.

- **The uncovered role is the primary object.** An `event_roles` row with
  `member_id IS NULL`. Every screen answers *which jobs have nobody on them*.
  Chosen over paperwork deadlines, kit loss and stalled edits.
- **Reads are open; writes need an account.** *Superseded the original
  "Station Manager only in v1" once the site went up on a public host and
  several people started editing.* The publishable key ships inside the page,
  so an unguessable URL is not an access control. Anyone can read the year;
  every INSERT, UPDATE and DELETE policy requires `auth.role() =
  'authenticated'`. Members are still names that hold roles — holding a role
  and having an account are separate things.
- **All four modules in v1** — crew, kit, societies, post-production — hanging
  off the event, not as four separate navigations.
- **A clash is a conflict of physical presence.** `event_roles.on_site` exists
  because an untimed editor role (work happens tomorrow, at a desk) otherwise
  clashed with everything that day. False clashes destroy trust in the one
  signal the product is built around.
- **Delete is allowed on plans, never on records.** `events`, `tasks` and —
  since the move to a shared database — `event_roles`. Kit bookings, ledger
  lines, deliverables and incidents have no DELETE policy: a record you can
  delete is a record you cannot rely on. Cancelling is separate and keeps the
  row. `event_roles` joined the list because removing a role has always been an
  offered action, and against a shared database it has to be a real DELETE or
  the role returns on the next pull. A role is a slot in a plan.
- **`incidents` (safeguarding) requires an authenticated session.** Every other
  table is readable with the anon key. Never join it into a list view.

## Working style this user expects

Modelled on `../JSS Organiser`, which has the same discipline.

- **Measure, don't estimate.** Contrast ratios come from a script; schema
  claims come from executing SQL; UI claims come from driving Chrome.
- **Reasoning goes in the file**, as comments explaining *why*, not *what*.
- **Rules are enforced by a script or they are not rules.** When the design
  changed, the audit rules changed with it — the old ones banned shadows, radius
  above 2px and side accents, all of which Studio Essential requires. What
  carried over is the principle, not the list.
- **No state carried by colour alone.** This one outlived the redesign and is
  the important one; four separate assertions in `shots.mjs` hold it.
- Assert the thing, not its neighbour. A z-index bug once survived because a
  test checked the edit and not the undo. Later, a test "passed" by clicking a
  sheet that was still sliding out, because it asserted the CSS class instead of
  the geometry. When something animates, wait on where it *is*.

## Not built

Designed into the schema, absent from every interface: kit check in/out and the
**Gear Locker screen** (Stitch designed it, but `data/year.json` has no `kit`
rows — build the data first), the post-production board, money (`ledger`,
`funding_windows`), playbook and handover export, safeguarding log. There is
still **no Next.js app**: the page is one self-contained file. Export gives back
a corrected `year.json`.

**The database is live.** Project `uciyizhmuiopetrdpovy` (eu-west-1) has the
schema pushed and the year seeded: 31 events, 78 roles (44 open), 56 tasks.
`npm run verify:api` asserts the deployed API enforces the rules, and
`npm run e2e:sync` drives two real browsers against it.

**Offline is tested by blocking DNS, not by hoping.** `e2e` and `verify:deploy`
launch Chrome with `--host-resolver-rules=MAP <db-host> ~NOTFOUND`. Both suites
were briefly passing for the wrong reason — the project had no tables, so every
request failed and the fallback engaged by accident. Pushing the schema broke
three checks, correctly: a remote pull was replacing the document mid-suite. If
you find yourself explaining why a test needs the database to be down, it does
not — block it.

**Deploying.** `vercel.json` builds to `dist/` and ships a tight CSP whose
`connect-src` names the Supabase project **by host**. Change projects and you
must edit `vercel.json` too — `npm run verify:deploy` fails if the CSP and the
built page disagree, rather than letting it fail silently on the deployed URL.

Supabase provisioning is fully headless *except* obtaining the access token,
which needs a browser session on the user's account. Given
`SUPABASE_ACCESS_TOKEN`, `npm run db:provision` creates the project, links it,
pushes the schema and writes `.env.local`; `npm run verify:remote` then asserts
the deployed database behaves (rolled back in a transaction, so it is safe
against a live project). Vercel needs `vercel login` the same way.
The migration is generated from `schema.sql` and `verify:sql` fails if they
drift, so what gets pushed is what was verified.
