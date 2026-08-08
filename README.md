# CTV OS

Internal operating system for **CampusTV**, University of Bath.

Built from the 2026 station manager handover document. Named to sit beside
[Cue](../Cue) and [Prism](../Prism).

> **Status: built, one step from live.** Strategy, visual system, data model,
> a working prototype and multi-client sync are done and verified. What is left
> is a single credential: creating the tables needs an access token or the
> database password, and neither Supabase key can run DDL. Until the schema is
> pushed, every client falls back to the seed year and says so — see
> [Sharing the year](#sharing-the-year).

## The one-line version

The handover is not a list of features. It is a year of **deadlines that run
backwards from events** — planner and risk assessment to Helen at least two
weeks out, merch ordered three to four weeks prior, crew call three hours
before gates at the Rec, edit published the next day. CTV OS computes those from
the event date, and puts **the role nobody is on** at the centre of every
screen.

## Documents

| File | What it settles |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Who it is for, the primary object, anti-references, principles |
| [DESIGN.md](DESIGN.md) | Tokens with measured contrast, type, layout, the signature component |
| [supabase/schema.sql](supabase/schema.sql) | The data model, with the reasoning in comments |
| [data/year.json](data/year.json) | The real 2026/27 year, pulled out of the handover |
| [prototype/sync.js](prototype/sync.js) | How several people edit the same year at once |

## The prototype

```bash
python3 scripts/build_prototype.py
open prototype/ctv-os.html
```

One self-contained file — data, Inter and the sync engine all inlined, so the
only host it ever contacts is its own database. It works from `file://`, from a
phone with no signal, and inside a strict CSP. Rebuild it after any change to
`data/year.json`.

The look is **Studio Essential**, a Google Stitch design system ported by hand;
`DESIGN.md` records how, and the two places the port departs from it on
measured grounds.

Five views, all reading the same data:

- **Overview** — four counts, then the uncovered roles themselves: which events
  still have a job with nobody on it, and what is next.
- **Calendar** — month grid with the academic year above it. Drag an event to
  another day to move it; `+` on any day adds one.
- **Schedule** — the same events as a timeline, each with a **Missing
  Requirements** panel naming the open roles and an Assign button that closes
  them without leaving the screen.
- **To do** — 56 tasks pulled out of every section of the handover, as a board
  grouped by when they bite or as a flat list, filterable by area, each carrying
  its section reference.
- **Crew** — who is trained on what, who is already committed, and who is
  double-booked.

The event sheet edits everything: title, date, times, venue, strand, status,
brief, and crew — each bay in the role bank is a dropdown, so closing a gap
takes one click. Every change is persisted to `localStorage` and **undoable**;
**Export** downloads your corrected `year.json`, and **Reset** returns to the
seed.

Nothing talks to a server yet.

## Verification

```bash
npm install
npm run verify            # tokens + contrast, schema on real Postgres, deploy artifact
npm run e2e               # 39 interaction checks in real Chrome
npm run shots             # 9 screenshots + the design-system audit
```

- **`verify:contrast`** does two jobs. It compares all 21 palette tokens back to
  `stitch/design-system.json`, because the CSS hand-copies them — the CSP blocks
  Tailwind — and a hand-copied palette rots quietly. Then it measures the 29
  foreground/background pairs the interface actually paints, compositing the ones
  set with opacity, since white text at 85% on a green pill is not white text.
  Every row names where it is used; a pair nobody renders is a pair nobody
  should be defending.

- **`verify:sql`** executes `schema.sql` on real Postgres (PGlite/WASM) — not a
  mock — and asserts the behaviour the product depends on: that an unassigned
  role reads as open, that one person in two places at once is detected exactly
  once, that an off-site editor never causes a false clash, that prep due dates
  follow an event when it moves, that kit which went out and did not come back
  is findable, that only `events` and `tasks` have a DELETE policy, and that the
  safeguarding table is unreadable by the anon key. 27 checks.

- **`verify:deploy`** serves `dist/index.html` with the exact headers from
  `vercel.json` and drives it in real Chrome. The CSP we ship is deliberately
  tight, and a CSP that is slightly too tight does not fail the build — it fails
  silently on the deployed URL in front of whoever opened it. This asserts no
  policy violations, that Inter actually rendered, and that a real edit still
  reaches `localStorage`.

- **`shots`** drives real Chrome and enforces what a screenshot cannot show: no
  external requests from any screen, Inter and nothing else, every radius on the
  8px scale, and no state carried by colour alone. The last of those is four
  assertions — every Missing Requirements panel worded and carrying its own
  Assign control, every card stating coverage as a fraction, every overdue task
  saying how late it is, every calendar badge naming its coverage in its
  accessible name. It also clicks through to Undo with the sheet open, because
  that is where a real bug once hid.

  These rules replaced the previous set. The old audit banned shadows, radius
  above 2px and side accents; Studio Essential requires all three, so keeping
  them would have meant enforcing the rejected design. What carried over is the
  principle — a rule is only worth having if a script can fail on it.

Real defects caught this way, because every one came from running something
rather than reading it:

1. **The editor clash.** Seeding the actual year showed Ela's untimed EDITOR
   role conflicting with everything else she did that day. Editing happens
   tomorrow at a desk, so the model gained `event_roles.on_site` and clash
   detection now means *physical presence*. False clashes would have destroyed
   trust in the single signal the product is built around.
2. **A new event looked finished.** An event with zero roles satisfies "no open
   roles" arithmetically, so it rendered in exactly the same green as a fully
   crewed one. It now has a third, neutral state reading *no roles yet* — a
   fabricated complete state is worse than an honest empty one.
3. **Undo was unclickable.** `--z-toast` and `--z-confirm` are declared in
   DESIGN.md's z-scale and were never defined in the prototype, so
   `z-index: var(--z-toast)` resolved to `auto` and the toast sat *under* the
   scrim. Clicking Undo closed the sheet and did nothing. It survived the first
   test run because that check asserted the edit and not the undo — a test that
   passed while the feature was broken.
4. **A task could block deleting an event.** `tasks.anchor_event_id` is
   `ON DELETE SET NULL`, which orphaned `lead_days` and tripped a check
   constraint, failing the whole DELETE. "Order merch" would have made the
   event it hangs off undeletable. Fixed with a `BEFORE UPDATE` trigger that
   clears the orphaned lead, so authoring a lead with no anchor is still
   rejected while the cascade is not.
5. **Form fields at 1.70:1.** Stitch's export puts `outline-variant` on inputs.
   A text field is empty until you type, so its border is the only thing saying
   a field is there, and WCAG 1.4.11 asks 3:1 of it. Moved to the same design
   system's `outline` token (4.51:1). Card borders and grid rules kept
   `outline-variant` — those are separators, not affordances.
6. **Unequal days.** The month grid used `repeat(7, 1fr)`, and because the event
   badges are `white-space: nowrap`, one long title floored its column at
   min-content and dragged it wider than the rest. `minmax(0, 1fr)` fixed it;
   the e2e suite now walks all eleven months and asserts seven equal columns.
7. **A test that passed by clicking the wrong thing.** Removing the sheet's
   `.is-open` class starts a 220ms slide; for that window it still covers the
   right third of the screen. A check asserting the class rather than the
   geometry clicked the sheet instead of the button underneath and failed
   somewhere else entirely. When something animates, wait on where it *is*.

## Deploying

```bash
npm run build:prototype   # -> dist/index.html, the only file the site needs
npm run verify:deploy     # prove it survives the production CSP
npm run deploy            # vercel deploy --prod
```

`vercel.json` builds to `dist/` rather than serving `prototype/`, so publishing
the site cannot accidentally publish the screenshots, the template or the fonts.

**The database is not deployed.** `supabase/schema.sql` is executed on real
Postgres by `verify:sql`, but that is PGlite in WASM — a real Postgres, not a
real Supabase. There is no project, no URL and no keys, and nothing in the
prototype talks to one; it persists to `localStorage` and exports `year.json`.

Creating it is headless apart from one step. `supabase login --token` takes a
Personal Access Token non-interactively, but minting that token needs a signed-in
browser session on your account — that is the auth boundary and nothing gets
around it. Once you have one (https://supabase.com/dashboard/account/tokens):

```bash
SUPABASE_ACCESS_TOKEN=sbp_xxx npm run db:provision
npm run verify:remote
```

`scripts/provision_supabase.sh` finds your organisation, creates the project in
`eu-west-2`, waits for the database to accept connections, writes credentials to
a gitignored `.env.local`, and pushes the schema. It is safe to re-run: if a
project of that name already exists it links to it rather than creating a second.

`verify:remote` is the check that answers "is the backend actually working". It
asserts the 15 tables and 6 views are really there, that RLS is on everywhere,
that only `events` and `tasks` have a DELETE policy, that safeguarding is
authenticated-only — and then exercises the behaviour: an unassigned role reads
as open through `event_coverage`, one person in two places at once is detected
once, an off-site editor causes no false clash, and deleting an anchored event
does not fail on its tasks. Every write runs in a transaction that is rolled
back, so verifying a live project leaves nothing behind. With `SUPABASE_ANON_KEY`
set it also goes through PostgREST, which is the part PGlite cannot test at all:
that the API in front of the database enforces the rules the database declares.

`node scripts/verify_remote.mjs --local` runs the same SQL against PGlite. That
proves nothing about your Supabase, which is the point of the remote mode — but
it means the first time the script meets a live database is not also the first
time anyone has run it. `verify:sql` includes it, and it caught two wrong column
names in `event_coverage` before a project existed.

`supabase/migrations/20260807000000_ctv_os_init.sql` is generated from
`schema.sql`, and `verify:sql` fails if the two have drifted — so what gets
pushed is the schema that was verified, not a second hand-edited copy of it.

## Sharing the year

The prototype kept the whole year as one document in `localStorage` and rewrote
all of it on every edit. That is exactly right for one person and exactly wrong
for several: two people editing different events would clobber each other,
because the unit of writing was the entire year.

The document stayed. The unit of *writing* became the row.

`mutate()` already cloned the year before every change so that undo could put it
back, and that clone turns out to be the other half of a diff. Comparing before
against after yields the handful of rows that actually moved, and only those are
written. Every one of the thirteen places that edit something got sync without
being modified, and an undo is the same diff applied in the other direction.

What that buys:

- two people editing different events never conflict — they write disjoint rows;
- two people editing the same field, last write wins, and the loser sees it
  within about a second over a Realtime socket;
- a dropped socket falls back to a 20-second poll, not to stale crew lists;
- no signal at all falls back to `localStorage`, with edits held in an outbox
  and replayed on the next successful write.

Reading pulls every table in full rather than asking for rows changed since a
watermark. A watermark cannot see a delete, so a fixture somebody else removed
would sit on your calendar until you reloaded — and a calendar showing an event
nobody is running is the precise failure this product exists to prevent. A year
is about 60 KB.

Writing needs an account. Reading does not. The publishable key is inside the
page, so "knows the URL" and "holds the key" are the same thing, and every
INSERT, UPDATE and DELETE policy in `schema.sql` requires a real session.

### Turning it on

```bash
npm run db:migration     # schema.sql -> supabase/migrations/
#   push that migration  (needs SUPABASE_ACCESS_TOKEN, the database password,
#                         or a paste into the dashboard SQL editor)
npm run seed             # load data/year.json into it
npm run verify:remote    # assert the deployed database behaves
npm run build:prototype  # bake SUPABASE_URL + the publishable key into the page
```

`vercel.json`'s `connect-src` names the project **by host**. Point the build at
a different project and you must edit it too — `npm run verify:deploy` fails
when the CSP and the built page disagree, rather than letting the page load
perfectly and silently fail to reach its data.

## What is not built

Designed into the schema, not yet in any interface (the **Gear Locker** screen
exists as a Stitch design in `stitch/`, but `data/year.json` has no kit rows to
put in it):

- Kit check in/out screens (`kit`, `kit_bookings`, `kit_outstanding` exist)
- Post-production board (`deliverables`, `post_outstanding` exist)
- Money (`ledger`, `funding_windows`)
- Playbook and handover export (`playbook`, `contacts`)
- Safeguarding log (`incidents`, already locked to authenticated reads)
- Any writing at all — the prototype is read-only

## Open questions

- **Term dates.** Only National Television Day (21 Nov) and the welcome-weekend
  rule are stated in the handover. Everything marked `"confidence":
  "estimated"` in `data/year.json` is inferred and shows *date to confirm* in
  the interface until checked against the SU calendar.
- **Committee names.** `data/year.json` seeds the committee from names in the
  handover plus placeholders. Replace before this is used for anything real.
