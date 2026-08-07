# DESIGN.md — CTV OS

The visual system is **Studio Essential**, a Google Stitch design system
generated for the *CampusTV Studio Hub* project and downloaded to
`stitch/design-system.json`. It is not ours. This document records how it was
ported, where the port deliberately departs from it, and which of those
departures a script enforces.

An earlier direction — dark-first, tally red/green, Archivo and Martian Mono —
was rejected. It is not described here and should not be reintroduced.

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

---

## Contrast

Measured by `npm run verify:contrast`, which resolves sRGB the way a browser
does. **29 pairs, all passing.** Every row names where it is actually used,
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
  be impossible to miss"; the overview now leads with that number at 56px and
  demotes the rest to a line of context.

Empty states say what the column is *for* rather than reporting an absence, tags
moved from 10px to 11px (Studio Essential's own label size, and the stated
primary context is a phone at arm's length in a dark venue), and prose is capped
at 54–68ch instead of running the full 1440px canvas.

## Motion

160ms on colour and border, 220ms on the sheet. Under
`prefers-reduced-motion: reduce` everything collapses to 1ms — asserted by
running Chrome with the media feature emulated, not by trusting the declaration.

The sheet's slide is the one place where "the class is set" and "the thing is
where you think it is" come apart. Both directions are waited on by geometry in
the e2e suite; asserting the class instead let a test click the sheet while it
was still sliding out and report a failure in the wrong place.
