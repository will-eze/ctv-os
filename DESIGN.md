# DESIGN.md — CTV OS

The visual system is **Studio Essential**, a Google Stitch design system
generated for the *CampusTV Studio Hub* project and downloaded to
`stitch/design-system.json`. It is not ours. This document records how it was
ported, where the port deliberately departs from it, and which of those
departures a script enforces.

An earlier direction — dark-first, tally red/green, Archivo and Martian Mono —
was rejected. It is not described here and should not be reintroduced.

**2026-08-08 feature pass.** New surfaces were added — the account menu and
sign-in/sign-up dialogs, the admin *Manage access* modal, the editable Kit
detail drawer (with photo, usage notes and tips), inline crew edit forms with a
job-descriptions reference, the event kit-needed picker, and the mobile to-do
filter dropdown — all built from the existing Studio Essential tokens (Inter,
the 8px radius scale, the seven type steps, the 4px spacing grid, worded state).
`npm run shots` holds them to that scale like everything else; the one carve-out
is `<option>`, a browser-rendered widget internal the grid cannot reach, now
skipped by the spacing audit. The **structured PDF** (`#print-report`) has its
own print stylesheet in points — it is never on screen and never audited.

---

## Where the design comes from

Seven screens were generated in Stitch and pulled down with the MCP:
Studio Dashboard, Event Schedule, Broadcast Calendar, Crew Directory, Gear
Locker, Production Tasks and Production Tasks (List View). All of them, plus
the token set, are in `stitch/` as HTML and PNG.

Stitch's export depends on three things the artifact CSP blocks outright: the
Tailwind CDN, Google Fonts, and Material Symbols. So none of the exported HTML
could be used directly. The port:

- **hand-writes the CSS** from `design-system.json`'s token set,
- **embeds Inter** as a subsetted variable woff2 (`prototype/fonts/Inter.woff2`,
  48 KB, wght 100–900 — one face covers the four weights Studio Essential asks
  for, where four static cuts would have been ~180 KB),
- **redraws every Material Symbol** as an inline SVG sprite on the same 24px
  grid.

`npm run shots` fails the build if any of that regresses: it watches the network
for a request that is not `file:` or `data:`, and asserts every rendered element
still resolves to Inter.

---

## Tokens

Copied verbatim from `designSystem.theme.namedColors`. `npm run verify:contrast`
compares all 21 back to the JSON on every run, because a hand-copied palette is
exactly the kind of thing that rots quietly.

| Role | Token | Hex |
|---|---|---|
| Canvas | `--bg` | `#faf8ff` |
| Card | `--card` | `#ffffff` |
| Sidebar | `--low` | `#f2f3ff` |
| Container / active nav | `--container` `--high` `--highest` | `#eaedff` `#e2e7ff` `#dae2fd` |
| Primary | `--primary` | `#004421` |
| Primary container | `--primary-c` / `--on-primary-c` | `#1d5c35` / `#92d2a1` |
| Text | `--on-surface` / `--on-surface-var` / `--secondary` | `#131b2e` / `#404941` / `#5c5f61` |
| Rules | `--outline` / `--outline-var` | `#707970` / `#c0c9be` |
| Error | `--error` / `--error-c` / `--on-error-c` | `#ba1a1a` / `#ffdad6` / `#93000a` |

Two documented exceptions, both taken from Stitch's *own* calendar screen rather
than invented: `--grid` `#e2e8f0` and `--grid-bg` `#f8fafc`. `--outline-var` is
a warm grey-green, and as the 1px rule of an entire month grid it reads green.

**Light only.** Studio Essential defines no dark palette, so there is no theme
switch. Offering one would mean inventing a second set of colours the design
system has nothing to say about.

### Shape and type

`roundness: ROUND_EIGHT`. Cards take 12px, controls 8px, small controls 4 and
6px, pills 999px. `npm run shots` fails on any radius outside that set — a
stray `border-radius: 2px` on the ribbon bar was caught this way.

Inter throughout, at Studio Essential's own scale: display 48/700, headline
32/600, title 24/600, subtitle 20/500, body 16 and 14/400, label 12/600 with
0.05em tracking and uppercase. Tabular figures wherever a number sits above or
beside another number — dates, counts, times, coverage fractions.

Those seven steps are now **enforced**, and were not before. The scale was
quoted in this document and nowhere else, so the CSS had quietly drifted to
thirteen sizes: 11px and 13px alone accounted for twenty-six declarations, each
a reasonable local decision, none of them on the scale, and collectively the
reason the page read as unresolved rather than designed. `npm run shots` reads
the *computed* size of every element that sets type on its own text — all five
views are in the DOM at once, hidden rather than unrendered, so one pass covers
the product — and fails on anything outside the seven. Measuring the rendered
page rather than grepping the stylesheet means an inline style cannot dodge it.

Spacing is a **4px grid**, the one Material and therefore Studio Essential is
built on, exposed as `--s1` through `--s8` and enforced the same way. There was
no spacing scale at all before — only `--gutter` and `--margin` — and about
forty distinct padding values had accumulated underneath them, including
`9px 11px`, `5px 6px`, `3px 7px` and `2px 2px 8px`. The audit checks padding and
gap but deliberately **not margin**: `getComputedStyle` reports margin's *used*
value, so `margin: 0 auto` would report whatever centring resolved to and fail
honest code.

That audit immediately caught three buttons sized by `width`/`height` that
declared no padding and were inheriting Chrome's UA default of `1px 6px` — off
the grid, and enough to sit their glyphs a pixel off centre. The fix is one
`padding: 0` in the button reset rather than three patches, which is the point
of having the rule run on every build.

---

## Contrast

Measured by `npm run verify:contrast`, which resolves sRGB the way a browser
does. **31 pairs, all passing.** Every row names where it is actually used,
because a pair nobody renders is a pair nobody should be defending.

The script also composites **opacity**. White text at 85% on a green pill is not
white text, and the previous version of this file could not see those cases at
all. Two were found and one was a real failure.

Two changes were made *against* Stitch's export, both because a measurement said
so:

**1. Form-field borders.** Stitch puts `outline-variant` on inputs. That is
1.70:1 on white, and WCAG 1.4.11 asks 3:1 of anything required to identify a
component. A text field is empty until you type, so its border is the only thing
saying a field is there — that boundary is load-bearing. CTV OS uses `--outline`
(4.51:1), which is the same design system's own token for boundaries that have
to be seen. Card borders and grid rules keep `outline-variant`, because a card
is already identified by its white fill and shadow, and a day cell by its number
and position; those are separators, not affordances.

**2. Empty day cards** in the week strip were set with `opacity: 0.55`, which
dropped the date to 3.86:1. Opacity fades the text along with the card, so the
state is carried by colour instead: `--bg` fill, `--secondary` number, 6.43:1.

The tightest *text* pair in the system is `on-primary-container` on
`primary-container` at **4.54:1** — Studio Essential's own value, passing AA by
a hair. It is worth knowing about before anyone adjusts the green.

---

## Colour is never the only signal

The one rule that survived the redesign intact, and the one that matters most:
an uncovered role is the object this product exists to surface, so it must say
so in words. `npm run shots` asserts all four of these and fails the build:

- every **Missing Requirements** panel carries a worded heading *and* the
  Assign control that closes the gap, inside the panel;
- every event card states coverage as `4/6 crewed`, never as a hue alone;
- every overdue task says how late it is;
- every calendar badge — which is one line of colour — carries its coverage in
  its accessible name.

There is a third state that exists only for this reason. An event with **zero
roles** satisfies "no open roles" arithmetically, so without it a brand-new
event rendered in exactly the same green as a finished one. `.is-bare` is
neutral and reads *no roles yet*. A fabricated complete state is worse than an
honest empty one.

---

## Layout

260px fixed sidebar on `--low`; a 64px sticky top bar at 80% white with a blur;
a canvas capped at 1440px with a 32px margin. Five views, all rendered on every
mutation and shown by `hidden`.

The **open-role count rides the Calendar and Schedule nav items**, so the one
number the product exists to drive down is legible from every screen.

### Z-index

Declared once and used by name: top bar 40, sidebar 50, scrim 60, sheet 70,
**toast 80**. The toast is above the sheet deliberately. A previous build
declared this scale in the design doc but never defined the custom properties,
`z-index: var(--z-toast)` resolved to `auto`, the toast sat under the scrim, and
Undo was unclickable. `npm run shots` now clicks through to it and asserts the
hit test lands on the button.

### The month grid

Stitch's Event Schedule is a **week strip only**. The month grid was a hard
requirement, so it was drawn in Studio Essential's language rather than carried
over: a white card, a 1px slate grid, and badges coloured by whether the event
still has a job nobody is doing.

It is **Monday-first**. Stitch's grid runs Sunday-first, which is a US
convention; a UK academic week starts on Monday and the weekend belongs together
at the end.

Whole weeks only, and the columns are `minmax(0, 1fr)` — a bare `1fr` floors at
min-content, and because the badges are `white-space: nowrap` a single long
title dragged its column wider and the seven days stopped being the same size.
A trailing week entirely outside the month is dropped, tested per week rather
than per day: breaking mid-row left the grid's own background showing through
cells that were never emitted. `npm run e2e` walks all eleven months of the
academic year and asserts whole Mon→Sun weeks and seven equal columns.

On a phone the grid survives — it is the thing that was asked for — but cells
drop the badge text and keep a coloured bar, which is the glanceable part.

### The year ribbon

Eleven months, August to June, each carrying its own count of open roles, so the
shape of the year's trouble is visible before you choose a month. Asked for
alongside the month grid; redrawn here as Studio Essential date cards rather
than the tally ticks of the rejected direction.

---

## What the polish pass changed

Three things were removed because they were decoration standing in for
information, and one because it was wrong:

- **The schedule card's 4px coloured left edge.** A side-stripe accent saying
  nothing the timeline node, the strand tag, the crewed fraction and the Missing
  Requirements panel were not already saying — and sitting where nobody scans.
  The node on the rail carries the state now; the eye is already following it.
- **The accent bar across the top of every crew card.** It duplicated the Clash
  tag, and on the six people who are not double-booked it said nothing at all.
  A clash now colours the card's own border.
- **Bordered, tinted kanban columns holding bordered white cards** — a card
  inside a card. The column only needs to say where it starts and how much is in
  it, which a heading rule does.
- **Four equal metric tiles on the overview.** They gave a count of events and a
  count of unconfirmed dates the same weight as the one number the product
  exists to drive to zero. PRODUCT.md is explicit that the uncovered role "must
  be impossible to miss"; the overview now leads with that number at display
  size and demotes the rest to a line of context.

Empty states say what the column is *for* rather than reporting an absence, tags
sit at Studio Essential's own 12px label size (the stated primary context is a
phone at arm's length in a dark venue), and prose is capped at 54–68ch instead
of running the full 1440px canvas.

## What the second pass changed

The first pass removed decoration. This one removed **duplication**, and put the
scales above under a script. Four more things went:

- **The overview's "Quick actions" card.** Four equal tiles — Add event, Month
  grid, To do, Crew — of which every one already existed in the sidebar, three
  under the identical name. It was a second navigation competing with the first,
  in the slot beside the number the product exists to drive to zero.
- **The tinted countdown box inside the "Next up" card.** A container inside a
  container, setting "6" in 44px as though it were the most important number on
  the page. It is not; the open-role count is, and it is 48px two columns to the
  left. The event is the subject of that card, so the event leads and the
  countdown is a line above it.
- **Red on the overview's role tags.** Every tag in that list is by construction
  an open role, under a heading that counts them and beside a fraction that
  grades them. Painting all three red meant a row with four open roles was five
  solid pink blocks, and at that density red ranked nothing. The tags name which
  jobs; the fraction stays red and says how bad. Outlining them was tried first
  and read as a row of form fields.
- **The crew card's second count.** "11 ahead" sat in the header beside "Roles
  this year 11" in the body — two adjacent numbers, usually within one of each
  other, occasionally identical, meaning different things. The header tag also
  pushed "Head of Production" onto a second line and left the six cards at
  ragged heights. One count now, on the list it counts.

One real defect surfaced while looking: the schedule's timeline rail is a single
absolutely-positioned line down the whole column, so it painted straight through
the in-flow month headers — the September rule cut the "21 OPEN" tag in half.
The header band now masks it in the page colour, which interrupts the spine at
each month, which is what a month break should do to a spine anyway.

## Motion

160ms on colour and border, 220ms on the sheet. Under
`prefers-reduced-motion: reduce` everything collapses to 1ms — asserted by
running Chrome with the media feature emulated, not by trusting the declaration.

The sheet's slide is the one place where "the class is set" and "the thing is
where you think it is" come apart. Both directions are waited on by geometry in
the e2e suite; asserting the class instead let a test click the sheet while it
was still sliding out and report a failure in the wrong place.

---

## The station-manager redesign (2026-08-08)

A pass on the manager's direct instructions, on top of the Stitch port. Four
changes touched the visual system; the behaviour and data model were not.

**The blue tint is gone.** Studio Essential's surfaces are a cool blue-grey ramp
(`background #faf8ff`, sidebar `#f2f3ff`, containers to `#dae2fd`). The manager
asked for the blue removed, so the six surface tokens were retuned to a warm
neutral grey — `--bg #f7f7f5`, `--card #ffffff`, `--low #f3f3f1`, `--container
#ededea`, `--high #e6e6e2`, `--highest #e0e0dc`, `--dim #d6d6d1` — and the two
grid tokens with them. Everything else (primary green, error reds, all text and
outline tokens) is still Stitch's, verbatim. This is a *third* documented
departure: `scripts/verify:contrast` moved those eight tokens from the
Stitch-equality `MAP` into `EXCEPTIONS`, where each is pinned to its exact value
so a neutral surface still cannot drift unnoticed. All 31 contrast pairs still
pass — the surfaces stayed light, so the text pairs measured on them barely
moved.

**Fewer borders, quieter pills.** Filter chips lost their 1px outline for a
filled low-surface pill (a transparent border holds the pressed-state metrics),
so a row of filters no longer reads as a row of outlined boxes. The schedule's
per-event tags were trimmed to the strand plus, when the flag is on, the crewed
fraction.

**The overview page was removed; the month calendar is home.** Its one
load-bearing readout — the count of roles nobody is on — did not vanish, it
moved behind the `flagCrew` setting (below). The calendar is laid out to fit one
viewport: a single header row (month nav + filters), a compact one-line year
ribbon (month label + event count, a small red dot only when the flag is on and
the month has open roles), and a shorter 92px day cell. The old overview CSS
(`.lede`, `.dash`, `.gap-*`, `.nx-*`) went with the page; `.meta-strip` and
`.faces` survived because the Kit summary and the schedule/sheet crew avatars
reuse them.

**Uncovered crew is opt-in.** Nobody is assigned to any event by default (every
seed `member` is `null`). The whole reason the product used to paint red — an
uncovered role — is therefore true of everything, so surfacing it automatically
would make the entire year red. Instead a single Settings toggle, `flagCrew`,
off by default and stored per-browser in `ctvos.prefs.v1`, turns the emphasis on
everywhere at once: the nav counts, the red calendar badges, the ribbon dots and
the schedule's Missing Requirements panels. This is a deliberate reversal of the
old "must be impossible to miss" stance, made by the person it is for. The
colour-signal rule still holds *when the signal is shown*: `shots.mjs` and
`e2e.mjs` switch the flag on before asserting it, because with it off there is
nothing to assert.

**Two new screens.** A read-only **Kit locker** (summary strip, state filters, a
table of worded statuses — attention states turn the word red and add a warning
glyph, never colour alone) built on a new `kit` array in `data/year.json`; and a
**Settings** page holding the toggle and Export/Reset. Screenshots were renumbered
(`01-calendar` … `06-settings`, `10-phone-schedule`).

**Mobile is the primary context, so nothing that carries information is allowed
to run off the side of the screen.** Two things did. The kanban board scrolled
sideways with its columns — cards past the right edge were simply gone — so under
900px it stacks vertically instead. And the data tables (Kit, the to-do list)
overflowed a 390px screen with Status and Location clipped off; they now collapse
to one stacked card per row, the header dropped and every cell labelling itself
from a `data-label` attribute. The event sheet, the schedule timeline and the nav
drawer were already full-width and needed nothing. The seed's crew is unassigned
now, so the **live database was re-seeded** (`npm run seed -- --force`) to match:
78 roles, all open.
