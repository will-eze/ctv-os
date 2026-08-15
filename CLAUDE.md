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

### 0.2 The Board — a private brainstorming canvas — APPLIED (2026-08-09)

Built in two passes. First a **local-only prototype** (its own `localStorage`
key, unsynced, ungated) so the manager could judge the fit; then, on their
go-ahead, **fully wired into the database and the access model**. Do not revert
without asking.

- **What it is.** A Lucidchart-lite pan/zoom canvas of idea notes you drag and
  link, one of several **named boards** (tabs; double-click to rename). Nav item
  **Board**, between Kit and Settings. Notes carry a colour tag (existing palette
  tokens only), auto-size to their text, and connect by dragging the green
  handle onto another note. Delete/Backspace removes the selection; **scrolling
  zooms about the cursor** (a trackpad pinch too); the background pans.
- **Content is in the document; the viewport is not.** Boards, notes and links
  live in `DATA.boards` and every change goes through `mutate()` — so it is
  undoable, it persists, and it **syncs** through the same diff as the rest of
  the year. Which board is open and each board's pan/zoom are a *per-person*
  preference and stay in `localStorage` key `ctvos.board.ui.v1`, never in the
  document, never synced. Typing commits on blur and a drag commits on release,
  so a `mutate()` repaint never fires mid-gesture and eats the caret.
  `render()` calls `Board.reflect()` to repaint from the document, including a
  change pulled from someone else.
- **Access: the third private module.** `board` joined `crew` and `tasks` in
  `PRIVATE_MODULES`, `VIEW_MODULE`, `GRANTABLE` and the Manage-access modal.
  Three tables — `boards`, `board_nodes`, `board_edges` — with RLS gated by
  `can_view('board')` / `can_edit('board')`, so the canvas is **admin-only by
  default** and grantable per account like the others. All three are deletable
  (a note/link/board is a plan the manager clears, not a record); deleting a
  board cascades its notes and links. Node identity is a slug (client id), edges
  name their endpoints by note slug; a board resolves at flush like an event.
- **Resilience.** The three board tables are **optional in `PULL`**: a live
  project that has not had this migration pushed yet 404s on them, and that must
  not take the public calendar offline, so those 404s degrade to an empty canvas
  rather than throwing. `data/year.json` seeds one example board (`boards`);
  `build_prototype.py` inlines it; `seed_supabase.mjs` loads all three tables.
  The prototype-phase local canvas (old `ctvos.board.v1`) is imported once into
  the document the first time it has no boards of its own.
- **Tests.** `verify:sql`/`verify:remote` DELETE-policy and gated-read lists and
  the private-module check gained the board tables; `verify_api.mjs` asserts the
  board is unreadable without a grant; `e2e` has a **BOARD** section (seed loads,
  a note persists and undoes, the viewport stays out of the document);
  `verify:deploy` expects **7 views / 7 nav items**.

**Live steps the user runs (needs their token; not done here):** `npm run
db:push` (adds `boards`/`board_nodes`/`board_edges` and their RLS), then
`npm run seed -- --force` (loads the seed board). Until then the live app shows
an empty canvas for granted users — correct, not broken. `verify:api` and
`e2e:sync` are theirs to run against the live project.

### 0.3 Freshers programme + coverage tags — APPLIED (2026-08-14)

Built to answer a new question the manager put to the SU: *which freshers events
is CTV covering, and which aren't?* The public calendar is the shared surface —
the SU manager opens the link, no account, and reads the colours. Do not revert
without asking.

- **The official Freshers' Week 2026 programme is in the calendar.** The 83
  events from `thesubath.com` (extracted to `data/freshers-2026-events.csv`, the
  raw store) were injected into `data/year.json` by `scripts/inject_freshers.mjs`,
  replacing the **12 estimated September placeholders** (the manager said those
  were guesses). They come in `confidence:"fixed"` (official), `roles:[]` (nobody
  by default). The 30 freshers-prep to-dos that hung off the `ww-fri` placeholder
  were **re-pointed to their official successors** (the Arrivals Party is the new
  freshers kickoff), not nulled — the lead-time engine stays intact. Event count
  went 31 → **102**; the two `eq(…, 102)` assertions in `e2e` track it.
- **Coverage colour tags.** Each event carries a `cover` field — `green` /
  `yellow` / `blue` / null. **The colours are arbitrary: they carry no fixed
  meaning** (the manager's explicit call). It syncs on the event row like
  `kit_needed` (new nullable `events.cover` column, in `eventRow`/`toDocument`),
  are **public-readable** (the shared link needs no account) and **writable only
  with a session**. Never carried by hue alone — the badge names its tag in the
  title, the schedule shows a worded chip, and the legend spells the three out —
  so `shots.mjs`'s four colour-only assertions still hold. Palette: green reuses
  `--primary`, yellow the kit `--warn` amber, blue is one new `--info` accent
  (pinned in `contrast.mjs` like `--warn`, with its fills). The manager can
  **name** what each colour means for themselves in Settings; those labels are a
  personal note in `localStorage` (`ctvos.prefs.v1`), never synced or exported.
- **Split view + multi-select + bulk actions**, all on the calendar (no new nav
  view, so still **7 views / 7 nav items**). **Split** lays the schedule beside
  the month (desktop ≥1000px). **Select** turns both surfaces into one shared
  pick-list; a floating **bulk bar** then applies a coverage colour, a strand, a
  status or a delete to everything picked, in one undoable `mutate()`. Both are
  per-person view state (`splitOn`/`selecting`/`picked`), never in the document.
- **Tests.** `e2e` gained a **COVERAGE TAGS + BULK** section (tag from the sheet
  shows and names on the badge; the bulk bar tags several at once and undoes; the
  legend names its colours and filters; split shows the pane). `openSheet` in
  `e2e` now taps the day first, because a busy freshers day caps its badges.
  `verify` is clean: 0 drift, **38 contrast pairs**, 30 schema, 11 deploy; `shots`
  audit passes; **69 e2e checks**.

**Live steps — already done; the live DB is now the source of truth (see §0.9).**
The freshers programme, the coverage column and the placeholder removal are all
in the live project. Note for the record: `seed` only ever **upserts**, it never
deletes, so it could not have "dropped" the old September placeholders on its own
— those were removed separately with `npm run clear:placeholders`. Do **not**
re-seed to reproduce this; the database already holds the correct 102 events.

### 0.4 Calendar refinements from the manager — APPLIED (2026-08-15)

Three small changes on the manager's instruction. Do not revert without asking.

- **A coverage tag fills the whole badge in its light wash, no left accent.** The
  earlier 4px inset ink bar is gone; the tag now colours the badge background
  (`.ev.cov-*:not(.is-open):not(.is-cancelled)`), overriding the neutral and the
  bare (no-roles) fills — because in the SU manager's shared view every event is
  bare and the colour is the whole point. The crew-gap red (`is-open`, flag-only)
  and the cancelled strike still win, so a live gap is never painted over. Still
  never hue alone: the badge title names the tag.
- **Multiple days expand at once, each collapsible.** The single `selectedDay`
  became a `expandedDays` **Set**. A busy freshers day still caps at three badges
  behind **"+N more"**; expanding lifts the cap for that day, "+N more" becomes
  **"Show less"**, and several days stay open independently (tapping a day toggles
  it; `data-expand`/`data-collapse` on the buttons). Still per-person view state,
  never in the document.
- **Cmd+Z / Ctrl+Z undoes the last change.** `mutate()` now stashes its undo in
  `pendingUndo`; a global keydown fires it (the same action as the toast's Undo).
  The model stays single-level (each mutation replaces it, taking it clears it, no
  redo). Ignored inside a text field / contenteditable so native text undo wins.
- **The split pane keeps its scroll.** Selecting a card in the split schedule
  opens the sheet, which rebuilds the calendar and used to snap the pane back to
  the top. `renderCalendar()` now saves `.split-pane .timeline`'s `scrollTop`
  before the repaint and restores it after — a transient DOM position, not state.
- **Tests.** `e2e` gained three checks (busy-day expand with several open at once;
  keyboard undo reverts a tag; split-pane scroll held through a sheet open) →
  **70 checks**. `shots` and `verify:contrast` unaffected (title words unchanged,
  tokens untouched).

### 0.5 Curated view links + access hardening — APPLIED (2026-08-15)

On the manager's ask for a link that shares *only chosen pages*, and to make
access "robust against attackers". Enforcement was already server-side (RLS); the
frontend admin UI was never the vulnerability. This pass closed the real gaps.
Do not revert without asking.

**First pass built scoped share links on Supabase Anonymous sign-ins; the manager
rejected that** — the dashboard warns anonymous sign-ins let anyone with the
publishable key mint throwaway users (DB/MAU bloat, needs a captcha). So it was
pulled. The insight: the **calendar is already public**, so "share only the
calendar" needs no auth at all — just a curated presentation. Access control is
kept for the genuinely private modules.

- **Curated view link (the #2 ask), client-side.** `?view=calendar,kit` narrows
  the nav to the named **public** pages — for sending the SU manager the calendar
  and nothing else. It is presentation over already-public data, **not** access
  control: `viewScope` (a Set of VIEW ids, parsed at boot) gates `renderNav`,
  `setView` and `firstAllowedView` via `inScope(id)`, but the **private** modules
  (crew/tasks/board) still resolve through `can_view()`/grants — so a tampered
  `?view=crew` shows nothing to someone without a grant. No backend, no token, no
  anonymous users. **Settings → Share a view link** builds and copies it
  (`SHAREABLE_VIEWS` = calendar/schedule/kit only; `copyViewLink()`).
- **Writes are now per-module, not "any login" (real hardening, kept).** The
  public tables' write policies moved from `auth.role() = 'authenticated'` (any
  account could edit or delete every event and kit item) to `can_edit(module)` —
  the same gate the private modules use. A non-admin now needs an **edit grant**
  on `events`/`kit` to change them. `events` joined `GRANTABLE` (label *Calendar*).
  `incidents` stays authenticated-only.
- **Privileged ops are SECURITY DEFINER RPCs with an audit trail (the #3 ask).**
  `admin_set_grant` / `admin_revoke_grant` / `admin_create_invite` each re-check
  `is_admin()` and write an **`access_audit`** row. The browser no longer writes
  `access_grants` / `invites` directly — `Sync.setGrant`/`createInvite` go through
  `rpc()` — so every access change is checked in one place and recorded. Table RLS
  still refuses a non-admin (defence in depth). `admins` still has **no write
  policy at all** — an admin can only be seeded by migration/SQL. Invites gained
  `expires_at` (honoured by `handle_new_user`); tokens are `new_token()` (two
  UUIDs, no pgcrypto dependency).
- **Tests.** `verify:api` gained: the audit trail is unreadable by anon, a
  **granted** editor writes (its account is granted `events` edit inline) and an
  **ungranted** session's write changes nothing. RPC bodies exercised end-to-end
  in PGlite (grant/invite/revoke + audit + non-admin blocked). Offline `e2e` (now
  **71**) gained the curated-link check; the write-tightening only engages online,
  which the `file://` suite never is. `verify` clean (38 contrast, 30 schema, 10
  remote, 11 deploy); `shots` clean.

**Live steps the user runs (needs their token; not done here):**
1. `npm run db:push` (adds `access_audit`, the admin RPCs, `invites.expires_at`,
   and the tightened per-module write policies).
2. `npm run verify:api` and `npm run verify:remote` to confirm the live surface.

**Note:** after the push, any invited **non-admin editor must be granted edit**
on the modules they work in (Calendar/Kit) from Manage access, or their writes
land nowhere — the admin account is unaffected (`is_admin()` bypasses). The view
link needs nothing enabled — it is a plain URL. Anonymous sign-ins should stay
**off**.

### 0.6 Signed-out = calendar only, and private events — APPLIED (2026-08-15)

Two changes on the manager's instruction. Do not revert without asking.

- **A signed-out visitor sees only the Calendar; signing in reveals the rest.**
  The default for an online, signed-out visitor is now the calendar alone — the
  rest of the nav (Schedule, Kit, To-do, Crew, Board, Settings) appears after
  sign-in, the private modules still further gated by a grant. A new
  `viewVisible(id)` layers it: a curated `?view=` link wins; then **offline/local
  shows everything** (the field case, and what `e2e` drives); then a signed-out
  visitor gets `PUBLIC_VIEWS` (= `calendar`); then a signed-in one gets whatever
  `canView(module)` allows. `renderNav`, `setView`, `applyGates` and the search
  groups (`MODULE_VIEW`) all route through it, so nothing off the calendar leaks —
  not even in search — when signed out. This is **nav/presentation** for the
  public modules (their table reads stay open); the real data boundary is RLS on
  the private modules and on private events (below). `SHAREABLE_VIEWS` bounds the
  `?view=` link to public pages, so a tampered `?view=crew` is dropped.
- **Private events (real RLS, not just hidden).** An event has an `is_private`
  flag (new `events.is_private` column, default false). The `events` SELECT policy
  became `using (not is_private or auth.role() = 'authenticated')` — so a private
  event is **invisible to the anonymous publishable key** the shared link carries,
  and visible only to a signed-in session. Set it in the event sheet
  (*Visibility* → public / private, a `data-private` toggle → `mutate`). It syncs
  on the event row (`is_private` in `eventRow`/`toDocument`, `private` in the
  document). Marked in words + a shape channel, never colour: a **padlock**
  (`#i-lock`, `.ev-lock`) on the badge with "· private" in its title, a worded
  **Private** chip on the schedule card, and a line in the Copy-details brief.
  Offline/local shows private events (no auth there); against the live DB the anon
  pull simply never receives them.
- **Tests.** `verify:sql` (now **31**) checks the events read policy is
  private-aware and exempts it from the "public tables readable" rule; `verify:api`
  plants a private event and confirms **anon sees nothing, a session sees it**
  (removed with the secret key). `e2e` (now **72**) sets an event private and
  asserts the padlock + worded state on badge and schedule, then reverts.
  `e2e_sync` now grants its throwaway editor `events` edit (the write-tightening).
  `verify` clean (38 contrast, 31 schema, 10 remote, 11 deploy, still 7 views);
  `shots` clean.

**Live steps:** covered by the same `npm run db:push` as §0.5 — the regenerated
migration now also adds `events.is_private` and the private-aware read policy.
Then `npm run seed -- --force` is **not** needed for this (the column defaults
false); an existing event is edited to private in-app.

### 0.7 UX polish pass — APPLIED (2026-08-15)

A production-readiness sweep on the manager's instruction. No schema change, no
live steps needed. Do not revert without asking.

- **Data persistence: pending edits survive a racing pull.** The real durability
  fix. `sync.js` replaced its two narrow overlay passes (`reinjectPending` +
  `reconcilePending` — which only protected deletes and register inserts) with one
  **`overlayPending(doc)`** that replays *every* pending outbox op — field edits
  and role/task/note updates included — onto a freshly pulled document. Without
  it, a pull landing between a local write and its flush (a Realtime echo, the 20s
  poll, a tab regaining focus) painted the server's older value over the edit: it
  flashed back and read as "my change didn't save". `scripts/verify_overlay.mjs`
  loads sync.js in node (browser globals stubbed) and asserts an edited venue,
  coverage tag, role, task tick, task delete, new event and board-note move all
  survive a racing pull; wired into `npm run verify` as **verify:overlay** (8
  checks). *Note: the live schema is current — this was never a migration gap.*
- **To-do edit + delete.** To-dos were tick-or-delete only. Clicking a card
  (board) or a row/title (list) now opens an **editor drawer** (reuses the sheet,
  keyed by `taskSheetId`): title, notes, area, owner, due date, a done toggle and
  a **Delete to-do** (confirms). Anchored to-dos show their inherited date and
  detach when a date is pinned. List rows gained a hover-× (dropped on phones,
  where the drawer's Delete is the touch path).
- **Board: a link dropped on empty canvas spawns a connected note.**
  `startConnect` now, on release over empty canvas after an actual drag, creates a
  note there and links it in one `mutate()` (`addConnectedNode`), then opens it to
  type — the quick way to branch an idea out.
- **The green event-title font is gone.** `.ev` default ink moved from `--primary`
  (green, which read as if it *meant* something) to `--on-surface` neutral. The
  named coverage tags keep their colours. `contrast.mjs`'s `.ev` pair updated
  (still 38 pairs).
- **A hand-added event starts untitled, with a placeholder.** `addEvent` no longer
  pre-fills the literal words "New event" as content to delete; the title field
  shows a **placeholder ("Event name")** and, wherever a title is *shown*, an
  `evTitle()` helper falls back to "Untitled event" (italic on the badge) so it is
  never blank.
- **Toasts: a plain notice hides the dead Undo button** and clears sooner (4s vs a
  change's 7s). Every `toast(text)` with no undo (Signed out, Copied, a failure,
  read-only) is now a clean notice. The help (`?`) text was corrected — it claimed
  edits are browser-only, untrue once synced.
- **Tests.** `e2e` gained the to-do-drawer edit/delete and the board
  drag-to-empty checks and updated the new-event assertion (empty title +
  placeholder + "Untitled event") → **74 checks**. `verify` clean (38 contrast,
  8 overlay, 31 schema, 11 deploy); `shots` clean.

### 0.8 Board reorder + events created on Save — APPLIED (2026-08-15)

Two changes on the manager's instruction; no schema change, no live steps. Do not
revert without asking. (A third report — "double-click to set an event private" —
was diagnosed as a **transient**: a local `file://` page that briefly reached
Supabase went signed-out read-only, so the first click hit the read-only gate; it
falls back to editable and the next click lands. Not a code fault — offline, a
single click always works. No change made.)

- **Board tabs reorder by dragging.** The order lives in `DATA.boards` (the array
  *is* the order), so a drag is a `mutate('Reordered boards')` like a rename — it
  persists, undoes and syncs. The dragged tab reflows live in the DOM under the
  finger; the new order is committed once, on release. A tab is still
  click-to-switch and double-click-to-rename; a press that does not move past a 6px
  threshold is a tap, not a drop, and the drop's trailing click is swallowed so it
  does not also switch. Tabs get `cursor: grab` + `touch-action: none` (off in
  read-only). The `boards` table already had `sort_order`; the **sync diff now
  writes a board row when its position changed**, not only its name (`posA` map in
  `sync.js`), so a reordered strip no longer snaps back on the next pull.
- **A hand-added event is a draft until Save** — the same shape as Add kit (§0.1).
  "New event" and a day's **+** open the sheet on an in-memory `eventDraft` that is
  **not in `DATA`** and written nowhere: no row on the calendar, no "Event added"
  toast, nothing synced, until Save. The draft sheet shows Details + Coverage &
  visibility with **Save/Cancel** (no Delete); the crew, kit and prep sections are
  hidden until the event exists to hang them on. Field edits, the coverage picker
  and the visibility toggle all write to the draft (no `mutate`); the two picker
  handlers in the delegated click listener are draft-aware. **Save** is the one
  write — one `mutate`, one row — then the full sheet reopens on the now-real event
  so its crew can go on. Close or Cancel throws the draft away (`closeSheet` clears
  `eventDraft`).
- **Tests.** `e2e` gained a board reorder/switch check and rewrote the new-event
  check to the draft flow (the **+** creates nothing; Cancel discards; Save writes
  once; then "Untitled event") → **75 checks**. `verify` clean (38 contrast, 8
  overlay, 31 schema, 11 deploy); `shots` clean.

### 0.9 The live DB is the source of truth; bulk-bar stranding fixed — APPLIED (2026-08-15)

A pre-push review pass. Do not revert without asking.

- **The live database is authoritative — do not re-seed to "fix" it.** The
  deployed project (`uciyizhmuiopetrdpovy`) is live, accurate, and the **source
  of truth** for the year's data: the manager maintains it in-app, and it holds
  edits that are not in `data/year.json`. `npm run seed` / `seed -- --force`,
  `clear:placeholders` and `repair:events` were **one-off migration helpers** —
  they have done their job and are **not part of a routine push**. A push now is
  code only (`npm run build:prototype` → `vercel deploy --prod`, or the schema via
  `db:push` when a migration changes). Running `seed --force` against the live DB
  would **upsert every row back to the file's values and wipe prod-only edits**
  (coverage tags, added events, crew), so treat it as destructive, not a refresh.
  The seed still exists for standing up a *fresh* project and for the offline
  prototype's inlined data — that is its only remaining role. (The earlier
  "Live steps … `seed -- --force`" notes in §0.1–§0.5 predate this and are
  superseded here; where they conflict, this section wins.)
- **The floating bulk bar no longer strands over other pages.** Select mode is a
  calendar-only concept (its toggle lives in the calendar toolbar; both pick
  surfaces — the month and the split schedule — are inside `v-calendar`), but
  `setView()` never cleared `selecting`/`picked` and never re-ran `renderBulkBar`.
  Because `.bulkbar` is `position: fixed; z-index: 60`, navigating away left it
  floating over Kit/Crew/Board/Settings/To-do with a **live Delete** that would
  destroy the still-picked events from a page that has nothing to do with them.
  `setView` now, on leaving the calendar, drops the selection, clears
  `body.is-selecting` and removes the bar in one step.
- **Tests.** `e2e` gained a check that picks an event, navigates to Settings, and
  asserts the bar and `body.is-selecting` are gone and select mode is off on
  return → **76 checks**. `verify` clean (38 contrast, 8 overlay, 31 schema, 10
  remote, 11 deploy, still 7 views); build regenerated (`ctv-os.html`, `dist/`).

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
npm run verify            # 38 contrast + 8 overlay + 31 schema + 11 deploy
npm run e2e               # 75 interaction checks in real Chrome, offline
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

The prototype's "now" is the real local date: `TODAY` in `template.html` is
computed from `new Date()`, so deadlines, Next Up, the today marker and the
to-do lead times all track the actual day the crew opens the tool. A
`?today=YYYY-MM-DD` query param pins it — `scripts/e2e.mjs` and `scripts/shots.mjs`
both append `?today=2026-08-07` to their `file://` URL, because their assertions
run against the fixed dates in `data/year.json` and would flap on a live "now".
Nothing else reads that param.

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
  URL is not access control. Anyone reads the **calendar**; **Crew, To-do and the
  Board are private** (RLS via `can_view`/`can_edit`); writes to the public
  modules need a session; the admin grants the rest. Members are still names that
  hold roles — holding a role and having an account remain separate things.
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
notes, photos) — what is not built is the check-out log against events. The
**Board (private brainstorming canvas) is built, synced and grant-gated** now
(see §0.2). There is still **no Next.js app**: the page is one self-contained
file. Export gives back a corrected `year.json`; **Export PDF** gives a
structured brief.

**The database is live and is the source of truth (see §0.9).** Project
`uciyizhmuiopetrdpovy` (eu-west-1) has the schema pushed, the board migration
applied, and the real year loaded — including the official Freshers' Week
programme (102 events) and any coverage tags and edits the manager has made
in-app. Those live edits are **not** all reflected in `data/year.json`, so **do
not re-seed to "sync" it** — `seed --force` upserts every row back to the file
and would wipe prod-only edits (destructive, not a refresh). Seeding is for a
fresh project only. `npm run verify:api` asserts the deployed API enforces the
rules, and `npm run e2e:sync` drives two real browsers against it.

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
