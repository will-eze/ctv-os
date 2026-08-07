# PRODUCT.md — CTV OS

Internal operating system for CampusTV, University of Bath.
Visual system lives in [DESIGN.md](DESIGN.md).

## Register

**Product.** The station manager is mid-year, mid-degree, and behind. Nobody
browses this. Every screen exists to answer a question that is about to become
a problem.

## Users & purpose

**One user in v1: the station manager.** Everyone else receives output from
CTV OS — a crew call pasted into WhatsApp, a call sheet, a kit list — but does
not log in. The committee (Head of Production, Head of Tech, Head of Marketing,
Head of Sport) exist in the data as people who hold roles and own prep, not as
accounts.

This is a deliberate v1 boundary, not a limitation to design around. It means
CTV OS can hold safeguarding notes, member details and society grievances
without an access-control layer, and it means the product has exactly one
person's attention to compete for.

**The context of use is the design constraint.** Two modes, unequally weighted:

1. **Dark venue, mid-event, 01:00.** Founders Hall during an arena night, the
   Rec at kick-off, the Edge during a dance showcase. Phone in one hand, kit in
   the other. A two-second glance answering *who is on what, and what is still
   in the van.* This is the mode the visual system is tuned for.
2. **Desk, planning, evenings and Sunday afternoons.** Filling in next month,
   chasing paperwork, assigning edits. Denser, slower, more typing.

**The job:** replace a ClickUp board nobody opened, a WhatsApp community where
decisions scroll away, a Google Drive nobody can navigate, and a handover
document that only exists because none of the above remembered anything.

## The primary object: the uncovered role

**An event with a role nobody is on is the most important object in CTV OS.** It
is the reason the product exists. It must be impossible to miss and impossible
to confuse with anything else.

The handover says this plainly in Section IIf — *"especially if it consistently
falls on you to pull through and your team are not showing up."* A station
manager who cannot see crew gaps a week out ends up operating three cameras
alone, or cancelling. Everything else in CTV OS — kit, societies, edits, money —
is downstream of whether a human being is standing in the right place holding
the right thing.

The uncovered role has exactly two forms, and CTV OS treats them as one class:

- **Open** — the role exists on an event and has nobody assigned.
- **Clashing** — one person is assigned to two things at the same hour, which
  is an open role that has not noticed yet.

## The four modules hang off the event

Kit, societies and post-production are not four separate products with four
navigations. They are three faces of an event, reached from the event:

| Module | The question it answers | Where it lives |
|---|---|---|
| **Crew** | Which jobs have nobody on them? | The role strip, on every scale |
| **Kit** | What left the hub, and is it back? | Event → kit, reconciled at de-rig |
| **Societies** | What has this group agreed to, and what did we learn last time? | Event → society, standing terms carried forward |
| **Post** | What is shot and not yet out? | Event → deliverables, with the next-day clock running |

A fifth thing is not a module but a mechanism: **prep with lead times**. The
handover is full of deadlines that run *backwards from an event* — planner and
risk assessment to Helen at least two weeks before, merch ordered three to four
weeks prior, crew call three hours before gates at the Rec, SD card into the
ATEM before the doors open, footage uploading at 02:00, edit out the next day.
CTV OS computes these from the event date rather than asking anyone to remember
them, and they surface as ordinary work in the calendar.

## The primary task per screen

- **Calendar** — the month, with the academic year always visible above it.
  Read what is coming; spot the days that are short. Lands here.
- **Production** — the same events as working documents. Open one and you get
  the call sheet: call times, role strip, kit, society terms, deliverables.
- **Crew** — every open and clashing role across the year in one list, so
  filling the rota is one pass rather than opening twelve events.
- **Kit** — what is out, who has it, what did not come back.
- **Post** — what is shot and not yet posted, oldest first, with the turnaround
  clock visible.
- **To do** — everything the handover tells you to do that is not tied to one
  event date: Section Ia's checklist, the finance and NaSTA admin, securing a
  successor. Grouped by when it bites rather than by section, because *what do
  I do next* is the question being asked — but every line keeps its handover
  reference so it can be checked against the document.
- **Playbook** — the handover, made queryable. Society cautions, contacts,
  runbooks, NaSTA categories and export settings. Grows all year and **exports
  next year's handover document**, which is the point.

## Nothing in this year is confirmed

The handover states exactly two dates: National Television Day is 21 November,
and welcome weekend is the Friday to Sunday before freshers. Everything else
was inferred from phrases like *"Rugby at the Rec in October"*.

That is not a data-quality problem to be fixed before the product is useful —
it is the condition the product opens in. So:

- **Events can be moved, edited and deleted.** Dragging an event to a new date,
  or typing one in, marks it confirmed; until then it says so.
- **Deadlines are derived, never stored.** Every prep item and every anchored
  task is *N days before its event*, so correcting one date corrects everything
  hanging off it. This is the payoff of the lead-time engine: the year is wrong
  when you get it, and fixing it is one edit rather than forty.
- **Delete is real, and undoable.** A fixture that was never real should be
  removable, not carried around struck through forever. Cancelling is the right
  action for an event that existed and got called off, and that still keeps the
  row. Deletion is allowed on events and tasks and refused everywhere else — a
  kit booking or a ledger line is a record of something that happened, and a
  record you can delete is a record you cannot rely on.

## Brand personality

**Operational. Broadcast-native. Unsentimental.**

The reference frame is the gallery and the paperwork that surrounds it: a tally
bank, a mixer's channel strip, a call sheet, a kit log. Confidence comes from
typographic discipline and a signal system that means something, never from
decoration.

The name is deliberately plain. Cue and Prism are products with names; this one
is the station's operating system and says so. It is the thing that holds
CampusTV up, and it should read as infrastructure rather than as a brand.

## Anti-references

- **Generic SaaS dashboard.** Rounded cards floating on grey, soft shadows,
  indigo accent, pill badges. This is what "looks AI-generated" means, and it
  is what the previous JSS build failed on.
- **Google Calendar clone.** Coloured blocks in hourly time columns. Wrong for
  a year where most days are empty and the ones that matter are all-day
  operations, and poor on a phone.
- **Broadcast costume.** Scanlines, CRT curvature, VHS chroma bleed, film
  grain, retro TV bezels, a "REC ●" that is not recording anything. The cheap
  move for a television product. CTV OS borrows broadcast's *information
  design* — tally states, channel strips, timecode, call sheets — and none of
  its nostalgia.
- **Consumer app cuteness.** Illustrations, emoji, playful microcopy. The
  station manager is doing a job.

## Accessibility & constraints

- **Dark-first, because the venue is dark**, with a genuine light counterpart
  for desk work — not an inverted dark theme. This inverts JSS deliberately:
  that product lived in July sun, this one lives in Founders Hall at 01:00.
- **Red and green are load-bearing, so colour is never the only signal.** A
  red/green pair is the classic colour-blind trap. Every state carried by
  colour is also carried by shape (filled versus hollow slot) and by words
  (`ROLE OPEN`, `4/6`). Strip all colour and the meaning survives.
- **One-handed operation.** The station manager is carrying a tripod. Primary
  actions in thumb reach; the open-role count never scrolls out of view.
- **Offline-tolerant.** Founders Hall has no signal at 01:00. Reads from cache;
  the stale state is stated, not implied.
- **The URL is the access control**, as in JSS — but unlike JSS this product
  holds safeguarding notes and member phone numbers, so the link is never
  shared and the safeguarding log is a separate route that is not linked from
  the navigation.

## Strategic design principles

1. **One object, three scales.** The role strip is the year ribbon, the month
   cell and the event detail. Learning to read it once means being able to read
   the whole product. This is the signature and it is the only place the design
   spends boldness.
2. **Red is a demand, green is a receipt.** Red means a human must act:
   role open, prep overdue, kit not returned, edit past its turnaround. Green
   means cleared and needs no further thought. There is no third meaning, and
   nothing else in the product is coloured.
3. **Time is the spine.** Monospaced, tabular, aligned. Dates and countdowns
   read down the page without the eye stopping on a word.
4. **Rules, not cards.** A month is a ruled document. No shadows, no floating
   panels, no nested containers.
5. **Empty is the normal state of a calendar.** Most of the CTV year is
   nothing. The design must make an empty week look calm rather than broken,
   and make the three loud weeks unmistakable.
6. **CTV OS writes the handover.** Every society caution, contact and runbook
   entered during the year is an entry in next year's document. The handover
   stops being an act of heroic recall in June.
