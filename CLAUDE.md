# CLAUDE.md — CTV OS

Internal operating system for **CampusTV**, the student TV station at the
University of Bath. Built from `Handover Document - CampusTV station manager
2026.pdf` (in this directory — read it before making product decisions). That
PDF and `CampusTV_Knowledge_Summary.txt` are **gitignored**: real internal
material, not ours to publish. They are on the station manager's machine, not
in a clone. `data/year.json` is the derived, shareable form.

**How it is used — build for that.** CTV OS is a working tool the station
manager *and the crew* use **regularly, across the whole academic year**, to run
real broadcasts as a student group — not a demo and not a one-off. Every feature
must be designed for that reality: several people editing the same year, on
phones in dark venues and on laptops in meetings, coming back week after week
from freshers to the summer ball. Before adding or changing anything, ask what
the crew actually does with it on a shoot day, and make the feature earn its
place in that workflow.

Sits beside the user's other projects: **Cue** (broadcast presentation
software) and **Prism** (camera training). Sibling repo `../JSS Organiser` is
the reference for how this user likes things built.

---

## ⚠️ Read this first

### 0. Station-manager redesign — APPLIED (2026-08-08)

A second pass, on the manager's direct instructions, changed the product on top
of the Stitch port. Do not revert these without being asked:

- **The blue tint is gone.** Studio Essential's cool blue-grey surface ramp was
  retuned to a warm neutral grey (`--bg #f7f7f5`, `--low #f3f3f1`, containers
  `#ededea`/`#e6e6e2`/`#e0e0dc`). Green, error, text and outline tokens are still
  Stitch's, verbatim. `scripts/contrast.mjs` moved the six surface tokens (and
  the two grid tokens) from `MAP` into `EXCEPTIONS`, so they are pinned as
  documented departures rather than checked against Stitch.
- **The Overview page was removed. The month calendar is the home screen** and
  is laid out to fit one viewport: a single header row, a compact one-line year
  ribbon, a shorter (92px) day cell.
- **Nobody is assigned by default.** Every `member` in `data/year.json` roles is
  `null` (34 seed assignments cleared). The uncovered-role emphasis is now
  **opt-in**: a `flagCrew` setting (Settings page, off by default, stored in
  `localStorage` key `ctvos.prefs.v1`, never synced or exported) gates the nav
  counts, the red calendar badges, the ribbon dots and the schedule's Missing
  Requirements panels. `scripts/e2e.mjs` and `scripts/shots.mjs` both switch it
  on at startup, because the invariant they test — the gap states itself in words
  — only applies when the signal is on.
- **The Kit locker is built.** `data/year.json` now has a `kit` array (20 items,
  aligned to `supabase/schema.sql`'s `kit` table) and there is a read-only Kit
  page: a summary strip, state filters and a table with worded statuses. Kit is
  reference data, inlined by `build_prototype.py`.
- **A Settings page exists.** The `flagCrew` toggle and Export/Reset live there.

Everything below this section predates that pass; where it conflicts (the
Overview screen, the always-on uncovered-role emphasis, "Gear Locker not built",
the blue palette), this section wins.

### 0.1 Feature build from the manager's notes — APPLIED (2026-08-08)

A pass driven by a page of handwritten notes and a second Stitch project
(`CampusTV Studio Hub`, id `1770876369783682792`). Do not revert without asking.

- **Accounts and role-based access.** The top-right avatar is now a real account
  control (sign in / out, identity, admin menu). Reads of the **calendar stay
  public**; everything else needs an account, and the **private modules — Crew
  and To-do — need a grant**. One admin (`willz.eze2023@gmail.com`, seeded into
  the `admins` table) invites people and sets **per-account, per-module
  view/edit grants** from a *Manage access* modal. New tables: `profiles`,
  `access_grants`, `invites`, `admins`; helper SQL functions `is_admin()`,
  `can_view(mod)`, `can_edit(mod)`; RLS on `members`/`tasks` resolves through
  them. **Invite flow is serverless:** the admin creates a one-time token
  (`?invite=<token>` link), the invitee signs up with it in `raw_user_meta_data`,
  and a `handle_new_user` trigger redeems it — no service key in the page.
- **The edit gate is connection-aware.** A client connected to the live DB and
  signed *out* is read-only (`body.is-readonly`, `mutate()` refuses). Offline or
  local (`file://`, the mode `npm run e2e` drives) stays fully editable and
  queues — the field case is not read-only. So the offline suites are unaffected.
- **Kit is built and editable.** Click a piece → a detail drawer (reuses the
  event sheet) to edit details, **usage instructions, tips**, and attach a
  **photo to a public Supabase Storage bucket `kit-photos`** (created by
  `schema.sql`; offline/local falls back to an inline data URI). Kit now syncs
  (added to `PULL`, `toDocument`, a `kit` diff), keyed by slug. `img-src` in
  `vercel.json` gained the storage host.
- **Crew is editable and carries job descriptions.** Inline edit of name /
  committee role / trained-on, plus *Add crew*; members now diff and sync. A
  *Roles & responsibilities* section copies the handover's committee roles
  (Section Va, verbatim) and the on-the-day crew roles. Crew is a **private
  module** (see access above).
- **Each event has a required kit list** (`kit_needed` jsonb on the event,
  edited in the sheet, in the copy text and the PDF) and a **Copy details**
  button that builds a paste-ready brief. The **Schedule picker was removed**
  (full timeline only). **To-do defaults to the list**, with the area filter
  collapsing to a dropdown on mobile.
- **Settings → Export PDF** is browser print-to-PDF via a print-only
  `#print-report` (a structured brief of the whole year); no library, never on
  screen so the design audit never sees it.

**Live steps the user runs (needs their token; not done here):** `npm run
db:push` to apply the regenerated migration (creates the accounts tables, the
private-module RLS and the `kit-photos` bucket), `npm run seed -- --force` to
load the new kit/`kit_needed` columns. `verify:api` and `verify:sql` were
updated to the new model; `verify:remote` too.

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
the one configured database, Inter only, radii on the 8px scale, **type on
Studio Essential's seven steps, spacing on the 4px grid**, and no state carried
by colour alone. That first rule reads the origin out of the built page rather
than out of a config, so it cannot drift from what shipped. The type and spacing
rules read *computed* styles off the rendered page rather than grepping the
stylesheet, so an inline style cannot dodge them; they were added after the CSS
was found to have drifted to thirteen type sizes and roughly forty padding
values, and they caught three more off-grid buttons on their first run. Spacing
checks padding and gap but not margin on purpose — `getComputedStyle` reports
margin's used value, so `margin: 0 auto` would fail honest code.

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
- **Reads of the calendar are open; the private modules and all writes need an
  account — and, for the private modules, a grant.** *Superseded twice: first
  "Station Manager only in v1", then "reads open, writes authenticated", now
  role-based access (see §0.1).* The publishable key ships in the page, so the
  URL is not access control. Anyone reads the **calendar**; **Crew and To-do are
  private** (RLS via `can_view`/`can_edit`); writes to the public modules need a
  session; the admin grants the rest. Members are still names that hold roles —
  holding a role and having an account remain separate things.
- **All four modules in v1** — crew, kit, societies, post-production — hanging
  off the event, not as four separate navigations.
- **A clash is a conflict of physical presence.** `event_roles.on_site` exists
  because an untimed editor role (work happens tomorrow, at a desk) otherwise
  clashed with everything that day. False clashes destroy trust in the one
  signal the product is built around.
- **Delete is allowed on plans and on the registers, never on records.**
  `events`, `tasks`, `event_roles`, `prep_items` — and, on the manager's
  instruction (2026-08-09), **`members` (crew) and `kit`**. Crew and the kit
  locker are the *register* a new committee resets: it has to be able to throw
  away the previous year's roster and inventory and start clean, not carry a
  growing pile of `active=false` rows forever. Deleting a person nulls the roles
  they held (`event_roles.member_id` is ON DELETE SET NULL — the slot reopens,
  the event survives); deleting a piece cascades its `kit_bookings`. Crew delete
  is gated by `can_edit('crew')`, kit delete by an authenticated session (kit is
  a public-write module). *This reverses the earlier "members are deactivated,
  kit is marked inactive" rule — do not reinstate it.* A **kit booking**, ledger
  line, deliverable and incident still have no DELETE policy: those are records
  of something that happened, and a record you can delete is one you cannot rely
  on. Cancelling an event is separate and keeps the row. `event_roles` and
  `prep_items` are deletable because removing a role or a prep step has always
  been an offered action, and against a shared database it has to be a real
  DELETE or it returns on the next pull. `npm run clear:crew-kit` is the one-off
  that wipes both tables on the live project; the seed in `data/year.json` is
  left intact so the offline prototype and the suites still have crew and kit.
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

Designed into the schema, absent from every interface: kit check in/out
(`kit_bookings`), the post-production board (`deliverables`), money (`ledger`,
`funding_windows`), playbook and handover export, safeguarding log
(`incidents`). The **Kit locker is built and editable** now (details, usage
notes, photos) — what is not built is the check-out log against events. There is
still **no Next.js app**: the page is one self-contained file. Export gives back
a corrected `year.json`; **Export PDF** gives a structured brief.

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
