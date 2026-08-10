-- GENERATED FILE — do not edit.
--
-- Source: supabase/schema.sql   (sha256 473043a15c5ca5bd)
-- Regenerate: npm run db:migration
--
-- schema.sql is what `npm run verify:sql` executes against real Postgres. This
-- is the same bytes, so what gets deployed is what was verified.

-- CTV OS — schema
-- Internal operating system for CampusTV, University of Bath.
-- Run once in the Supabase SQL Editor. Safe to re-run: everything is
-- IF NOT EXISTS / CREATE OR REPLACE.
--
-- Design note: the whole model hangs off `events`. Crew, kit, societies and
-- deliverables are faces of an event, not four parallel products — see
-- PRODUCT.md. The single most important row in this database is a row in
-- `event_roles` with `member_id IS NULL`.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  -- Strands are the editorial pillars from the knowledge summary, plus the
  -- operational ones the handover implies (training, admin).
  create type strand as enum (
    'freshers', 'sport', 'society', 'studio',
    'ball', 'training', 'awards', 'admin', 'social'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  -- No 'live' state: an event is live for four hours a year and the calendar
  -- already knows the date. Status tracks commitment, not the clock.
  create type event_status as enum (
    'idea',        -- someone asked, nothing agreed
    'planned',     -- we are doing it, details forming
    'confirmed',   -- paperwork in, crew called, kit booked
    'wrapped',     -- shot; post-production may still be running
    'cancelled'    -- kept, never deleted, struck through
  );
exception when duplicate_object then null; end $$;

do $$ begin
  -- Not one date in 2026/27 is confirmed. The handover states exactly two —
  -- National Television Day on 21 November, and welcome weekend being the
  -- Friday-to-Sunday before freshers — and everything else was inferred from
  -- phrases like "Rugby at the Rec in October".
  --
  -- The interface renders 'estimated' as "date to confirm", which is the whole
  -- reason events are movable. Storing the date without storing how much it is
  -- worth would turn 31 guesses into 31 facts on the way into the database.
  create type date_confidence as enum ('fixed', 'estimated');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Handover Ib/Id: vision mix + PTZ on arena nights, gantry/box/roaming at
  -- the Rec, interviewer + cam op pairs everywhere.
  create type crew_role as enum (
    'producer', 'vision_mix', 'ptz', 'camera', 'interview',
    'audio', 'editor', 'runner', 'stills'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type deliverable_kind as enum (
    'interview_clip', 'highlight', 'reel', 'livestream', 'longform', 'stills'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type kit_state as enum ('in_hub', 'booked', 'out', 'returned', 'missing', 'repair');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- members — people. A login is NOT required to be crewed.
-- ---------------------------------------------------------------------------
-- v1 has one account (the station manager). Everyone else exists here as a
-- name that can hold a role and sign kit out. See PRODUCT.md → Users.

create table if not exists members (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null,
  known_as        text,                     -- what goes in a role slot: 'Ela'
  committee_role  text,                     -- 'Head of Tech' etc, free text: the
                                            -- handover says roles get switched around
  phone           text,
  email           text,
  -- Handover IIIb: everyone that touches kit needs an SU membership. This is
  -- checked by hand against the SU site, so we record when, not just whether —
  -- a check from last October is not evidence about this year.
  su_member       boolean not null default false,
  su_checked_on   date,
  -- Handover Ia/Ic: camera and editing training gate what you can be given.
  trained         text[] not null default '{}',   -- 'camera','edit','vision_mix','ptz','audio'
  active          boolean not null default true,
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists members_active_idx on members (active, full_name);

-- ---------------------------------------------------------------------------
-- societies — who asks us for things, and what we learned last time
-- ---------------------------------------------------------------------------
-- Section II is almost entirely institutional memory that currently only
-- exists in a handover PDF. Held as data, it can be shown on the event.

create table if not exists societies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  contact_name    text,
  contact_email   text,
  -- What they always want. Dance Soc: 'camera at the back of the theatre,
  -- room mic for the tap noises'. Shown on every event for this society.
  standing_terms  text,
  -- What went wrong last time. Dance Soc: 'NEVER take the sound desk feed.'
  -- Surfaced as a caution, not buried in notes.
  cautions        text,
  -- Handover IIa: sport is generally free; ticketed events we can charge.
  charge_policy   text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events — the spine
-- ---------------------------------------------------------------------------

create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  slug          text unique,
  date          date not null,
  end_date      date,                       -- multi-day: freshers week, welcome weekend
  -- Times are nullable throughout because the source genuinely omits them and
  -- inventing one is worse than leaving the gutter blank.
  call_time     time,                       -- crew call — when OUR people arrive
  doors_time    time,                       -- gates/doors — the hard deadline
  start_time    time,                       -- kick-off / first act
  end_time      time,
  venue         text,
  strand        strand not null default 'society',
  status        event_status not null default 'planned',
  -- How much the date above is worth. See the enum for why this is not
  -- optional. New events created in the interface default to 'estimated',
  -- because a date somebody typed in August is a guess like any other.
  date_confidence date_confidence not null default 'estimated',
  society_id    uuid references societies(id) on delete set null,
  -- Handover IIa: we do not usually charge sport, but do charge for ticketed
  -- events and things like kickboxing.
  charge_gbp    numeric(8,2),
  charge_note   text,
  -- Handover Ic: the risk assessment and event planner are the head of tech's
  -- job and must be with Helen at least two weeks out. Tracked as prep, but
  -- denormalised here because it is the question asked most often.
  planner_sent_on   date,
  risk_assessed_on  date,
  brief         text,                       -- what we are actually making
  notes         text,
  cancelled_reason text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists events_date_idx on events (date, start_time);
create index if not exists events_strand_idx on events (strand, date);

-- ---------------------------------------------------------------------------
-- event_roles — THE primary object
-- ---------------------------------------------------------------------------
-- One row per job that needs a human. `member_id IS NULL` is an open role, and
-- an open role is the thing the entire product is designed to surface.
--
-- Roles are created from a template when the event is created, so an arena
-- night starts life with six open roles rather than with none — the gap has to
-- exist before it can be seen.

create table if not exists event_roles (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events(id) on delete cascade,
  -- Nullable, because "a job that needs doing, type not decided yet" is a real
  -- state and the interface has always been able to produce it: Add role gives
  -- you a row called NEW ROLE, and the type is inferred when you name it. The
  -- open role is the primary object here, and refusing to store one until
  -- somebody classifies it would be the tail wagging the dog.
  role         crew_role,
  -- The operational name, which is not the same as the role type: two rows are
  -- both `camera` but one is 'GANTRY' and one is 'ROAMING' and they are not
  -- interchangeable on the day.
  label        text not null,
  member_id    uuid references members(id) on delete set null,   -- NULL => OPEN
  -- Sub-window within the event. Arena nights run 22:00–02:00 but the
  -- interview pair is outside from 22:00 and the vision mixer is in the
  -- gallery until 02:00 — clash detection needs the real hours.
  from_time    time,
  to_time      time,
  -- A clash is a conflict of PHYSICAL PRESENCE. The editor is a real job that
  -- can be open, so it belongs in the role strip, but the work happens the
  -- next day at a desk — an editor with no stated hours must not read as being
  -- in two places at once. Without this, every event with an assigned editor
  -- generates a false clash, and false clashes destroy trust in the one signal
  -- the product is built around.
  on_site      boolean not null default true,
  sort_order   int not null default 0,
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists event_roles_event_idx on event_roles (event_id, sort_order);
-- Partial index: open roles are queried on every screen, and they are the
-- minority of rows, so this is the one that matters.
create index if not exists event_roles_open_idx on event_roles (event_id)
  where member_id is null;

-- ---------------------------------------------------------------------------
-- prep_items — the lead-time engine
-- ---------------------------------------------------------------------------
-- The handover is mostly deadlines that run BACKWARDS from an event date:
-- planner to Helen T-14, merch ordered T-28, press passes T-7, crew call T-0.
-- CTV OS computes the due date rather than asking anyone to remember the rule.
--
-- `lead_days` is days BEFORE the event. due_on is generated, so it follows the
-- event date automatically when a fixture moves — which they do.

create table if not exists prep_items (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events(id) on delete cascade,
  label        text not null,
  detail       text,
  lead_days    int not null default 0,
  owner_role   text,                         -- 'Head of Tech', 'Marketing'
  owner_id     uuid references members(id) on delete set null,
  done_on      date,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists prep_items_event_idx on prep_items (event_id, sort_order);

-- Due date lives in a view rather than a generated column: a generated column
-- cannot reference another table, and the rule genuinely belongs to the pair.
-- Columns are listed rather than `p.*` on purpose: `create or replace view`
-- cannot insert a column into the middle of an existing view, so a later
-- `alter table prep_items add column` (event_ref) would otherwise change what
-- `p.*` expands to and break the replace on the second run. Naming the columns
-- pins the view's shape regardless of what the table gains.
create or replace view prep_due as
  select
    p.id, p.event_id, p.label, p.detail, p.lead_days,
    p.owner_role, p.owner_id, p.done_on, p.sort_order, p.created_at,
    e.date                                    as event_date,
    e.title                                   as event_title,
    (e.date - p.lead_days)                    as due_on,
    (p.done_on is null and e.date - p.lead_days < current_date) as overdue,
    (e.date - p.lead_days) - current_date      as days_until_due
  from prep_items p
  join events e on e.id = p.event_id;

-- Reusable checklists. Applied at event creation; the copy on the event is
-- then editable, because the rule is not the truth (JSS's lesson, kept).
create table if not exists prep_templates (
  id           uuid primary key default gen_random_uuid(),
  -- NULL means every strand. Three of these apply to anything we point a camera
  -- at — the planner and risk assessment to Helen at T-14, kit booked out at
  -- T-3, roles advertised at T-10 — and they are the ones that actually get
  -- forgotten. data/year.json writes that as "*"; the enum has no wildcard
  -- member and should not get one, because 'freshers' and 'sport' name real
  -- editorial pillars and "*" would not.
  strand       strand,
  label        text not null,
  detail       text,
  lead_days    int not null default 0,
  owner_role   text,
  sort_order   int not null default 0
);

-- Not `unique (strand, label)`: two NULL strands never compare equal, so that
-- constraint would accept the same universal template twice and the seed would
-- stop being idempotent.
--
-- Two partial indexes rather than one on `coalesce(strand::text, '*')`, because
-- casting an enum to text is only STABLE — the cast depends on the enum's
-- current labels — and Postgres refuses a non-IMMUTABLE function in an index
-- expression. These say the same thing and are indexable.
create unique index if not exists prep_templates_key
  on prep_templates (strand, label) where strand is not null;
create unique index if not exists prep_templates_any_key
  on prep_templates (label) where strand is null;

-- ---------------------------------------------------------------------------
-- kit — the register and the check-out log
-- ---------------------------------------------------------------------------
-- Handover Ic + IIe + Peter's section: know what is booked out, when it left,
-- and whether it came back. The Rec de-rig is the case that matters — kit
-- travels to a venue by bus at night and has to be counted back in.

create table if not exists kit (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  category     text,                         -- 'camera','lens','audio','cable','media','lighting'
  asset_tag    text unique,
  owner        text not null default 'ctv',  -- 'ctv','su','hired','borrowed'
  state        kit_state not null default 'in_hub',
  home         text,                         -- where in the Media Hub it lives
  notes        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists kit_bookings (
  id           uuid primary key default gen_random_uuid(),
  kit_id       uuid not null references kit(id) on delete cascade,
  event_id     uuid references events(id) on delete set null,
  -- Nullable event: the handover also describes members borrowing kit for
  -- their own projects (IIIb, the scheme Chris Lyons and Jade ran).
  member_id    uuid references members(id) on delete set null,
  booked_for   date not null,
  out_at       timestamptz,
  out_by       uuid references members(id) on delete set null,
  back_at      timestamptz,
  back_by      uuid references members(id) on delete set null,
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists kit_bookings_event_idx on kit_bookings (event_id);
create index if not exists kit_bookings_date_idx on kit_bookings (booked_for);
-- Out and not back: the de-rig question.
create index if not exists kit_bookings_outstanding_idx on kit_bookings (kit_id)
  where out_at is not null and back_at is null;

-- ---------------------------------------------------------------------------
-- deliverables — the post-production pipeline
-- ---------------------------------------------------------------------------
-- Handover Ib: interview clips are edited and published THE NEXT DAY. That
-- turnaround is the whole point, so it is a column and not a convention.

create table if not exists deliverables (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events(id) on delete cascade,
  title         text not null,
  kind          deliverable_kind not null default 'interview_clip',
  -- The pipeline, as timestamps rather than a status enum: each stage answers
  -- "when", and a NULL is exactly "not yet". A status column would lose the
  -- history and force a decision about what "in review" means.
  shot_on       date,
  ingested_at   timestamptz,                 -- Ib: hub PC at 02:00, onto the Drive
  editor_id     uuid references members(id) on delete set null,
  due_on        date,                        -- default: shot_on + 1
  reviewed_at   timestamptz,                 -- IIf: SM watches for language / SU slander
  posted_at     timestamptz,
  platforms     text[] not null default '{}',-- 'instagram','youtube','tiktok','facebook'
  drive_url     text,
  -- Handover VIb/VIe: NaSTA categories and the export settings that invalidate
  -- a submission if wrong.
  nasta_category text,
  export_checked boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists deliverables_event_idx on deliverables (event_id);
-- Shot and not out: the post view's only query.
create index if not exists deliverables_outstanding_idx on deliverables (due_on)
  where posted_at is null;

-- ---------------------------------------------------------------------------
-- tasks — the handover's standing to-do list
-- ---------------------------------------------------------------------------
-- Distinct from prep_items, which belong to one event. These are the
-- obligations that run alongside the whole year: Section Ia's checklist, the
-- finance and NaSTA admin, securing a successor. Each one keeps the handover
-- section it came from so any line can be checked against the document.
--
-- A task is dated one of two ways and never both: a fixed date, or `lead_days`
-- before an anchor event — so it moves when that event moves. Not one date in
-- 2026/27 is confirmed, so the second form is the common one.

create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique,
  title           text not null,
  detail          text,
  area            text not null,        -- setup|training|money|socials|team|nasta|legacy
  source          text,                 -- 'Ia', 'IIIc', 'VIg' — the handover section
  owner_role      text,
  owner_id        uuid references members(id) on delete set null,
  due_on          date,
  anchor_event_id uuid references events(id) on delete set null,
  lead_days       int,
  done_on         date,
  academic_year   text not null default '2026/27',
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  -- Exactly one dating scheme, or none yet. Both at once would make the due
  -- date ambiguous, and ambiguity in a deadline is the thing this table exists
  -- to remove.
  constraint tasks_one_dating check (
    (due_on is null and anchor_event_id is null)
    or (due_on is not null and anchor_event_id is null)
    or (due_on is null and anchor_event_id is not null)
  ),
  constraint tasks_lead_needs_anchor check (lead_days is null or anchor_event_id is not null)
);

create index if not exists tasks_area_idx on tasks (academic_year, area);
create index if not exists tasks_open_idx on tasks (academic_year) where done_on is null;

-- Deleting an event fires ON DELETE SET NULL on anchor_event_id, which would
-- leave lead_days orphaned and trip tasks_lead_needs_anchor — making the whole
-- DELETE fail. Since events are deletable, that would mean "Order merch"
-- silently blocking the removal of the event it hangs off. Clear the lead on
-- update only: authoring a task with a lead and no anchor is still a mistake
-- and still rejected.
create or replace function tasks_clear_orphan_lead() returns trigger as $$
begin
  if new.anchor_event_id is null then new.lead_days := null; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_clear_lead on tasks;
create trigger tasks_clear_lead before update on tasks
  for each row execute function tasks_clear_orphan_lead();

-- ---------------------------------------------------------------------------
-- board — the private brainstorming canvas
-- ---------------------------------------------------------------------------
-- A whiteboard the station manager thinks the year out on: notes you drag
-- around and link. It is a private module like crew and the to-do list — every
-- read and write resolves through can_view('board') / can_edit('board'), so it
-- never appears on the public calendar URL. Three tables: a board, its notes,
-- and the links between them.
--
-- Notes and links are deletable for the same reason a role or a prep step is:
-- removing one is an edit the canvas offers, and against a shared database that
-- removal has to be a real DELETE or it returns on the next pull. A board is
-- deletable too — it is a scratchpad the manager clears, the same register
-- reasoning as crew and the locker — and deleting one cascades its notes and
-- links. Identity is a slug (the client-minted id, like events and members), so
-- a client that has never reached the network still queues edits that land on
-- the right rows instead of duplicating them. The camera (pan/zoom) is a
-- per-person viewport preference and lives in the browser, never here.
create table if not exists boards (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique,
  name          text not null,
  sort_order    int not null default 0,
  academic_year text not null default '2026/27',
  updated_at    timestamptz not null default now()
);

create table if not exists board_nodes (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique,
  board_id    uuid not null references boards(id) on delete cascade,
  x           double precision not null default 0,
  y           double precision not null default 0,
  body        text not null default '',
  color       text not null default 'grey',
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);
create index if not exists board_nodes_board_idx on board_nodes (board_id);

-- A link between two notes. The endpoints are the notes' slugs, not foreign
-- keys: the canvas addresses a note by the same client id everywhere, the link
-- travels with it, and a dangling endpoint (a note deleted out from under a
-- link) is simply not drawn. The client deletes a note's links along with it, so
-- that does not normally arise; board_id still cascades, so clearing a board
-- takes its links with it.
create table if not exists board_edges (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique,
  board_id    uuid not null references boards(id) on delete cascade,
  from_node   text not null,
  to_node     text not null,
  updated_at  timestamptz not null default now()
);
create index if not exists board_edges_board_idx on board_edges (board_id);

-- ---------------------------------------------------------------------------
-- Multi-client sync — columns
-- ---------------------------------------------------------------------------
-- The prototype stopped being one station manager's local file the moment more
-- than one person opened it. Six tables are editable from the interface, so
-- those six are the ones that have to converge. Two things are needed, and
-- neither is exotic.
--
-- `slug` gives members and societies a stable identity that survives seeding.
-- events and tasks already had one, and prep_templates has a natural key in
-- unique (strand, label). Without it, re-running the seed would mint fresh
-- uuids and every client would disagree about who 'ela' is — a role strip
-- reads `member: "ela"`, so that string has to mean something. The slug is the
-- id from data/year.json, so the seed is idempotent and the export can
-- round-trip back to the same file.
--
-- `updated_at` is what lets a client ask what changed since it last looked.
-- Only events had it, because until now nothing else was ever read back.
--
-- This block sits HERE, above task_due, and not in the Triggers section with
-- the rest of the sync plumbing. task_due is `select t.*`, so adding a column
-- to tasks reorders the view's columns — and `create or replace view` refuses
-- to rename a column. Run the alters after the view and the second run of this
-- supposedly re-runnable file fails. `npm run verify:sql` catches it, which is
-- the only reason it is not still broken.

-- Two columns loosened, for the same reason the block exists at all: this file
-- promises to be re-runnable, and `create table if not exists` skips the whole
-- definition on a database that already has the table. Editing the CREATE above
-- changes nothing for a project that was created before the edit, which is
-- every project that already exists. Both of these were caught that way — the
-- schema pushed clean and the seed then failed against the older columns.
alter table prep_templates alter column strand drop not null;
alter table event_roles    alter column role   drop not null;

alter table members   add column if not exists slug text;
alter table societies add column if not exists slug text;

-- Kit became editable from the interface: a stable slug to write against (the
-- id from data/year.json, like events and members), plus the fields the detail
-- drawer edits — how to use a piece, tips, and a photo in Storage.
alter table kit add column if not exists slug text;
alter table kit add column if not exists usage text;
alter table kit add column if not exists tips text;
alter table kit add column if not exists photo_url text;
alter table kit add column if not exists updated_at timestamptz not null default now();
create unique index if not exists kit_slug_key on kit (slug);

-- The kit an event needs, as jsonb: a short list of {id, qty} keyed by kit
-- slug. Event-scoped and small, so it lives on the event rather than in a join
-- table — it travels with the same events write the rest of the sheet makes,
-- and the interface reads it straight back. A join table (event_kit) would be
-- the move if kit needed its own coverage view; it does not yet.
alter table events add column if not exists kit_needed jsonb not null default '[]'::jsonb;

-- A template prep step is the strand-wide rule, applied to every event of the
-- strand. An event can opt out of one without touching the shared template: the
-- template's label goes in this per-event skip list and it stops showing on that
-- event. Small and event-scoped, so it rides on the event row like kit_needed.
alter table events add column if not exists prep_skip jsonb not null default '[]'::jsonb;

-- A prep step can instead be a link to another event on the calendar — a shoot
-- whose date is the prep deadline (camera training before the match). It then
-- takes its date from that event rather than a lead time, and moves when the
-- event moves. Nulled if the referenced event is deleted; the step survives so
-- it can be cleaned up.
alter table prep_items add column if not exists event_ref uuid references events(id) on delete set null;

create unique index if not exists members_slug_key   on members (slug);
create unique index if not exists societies_slug_key on societies (slug);

alter table members        add column if not exists updated_at timestamptz not null default now();
alter table societies      add column if not exists updated_at timestamptz not null default now();
alter table prep_templates add column if not exists updated_at timestamptz not null default now();
alter table event_roles    add column if not exists updated_at timestamptz not null default now();
alter table tasks          add column if not exists updated_at timestamptz not null default now();

-- The list the To do screen reads. An anchored task with a deleted anchor has
-- no date rather than a wrong one.
create or replace view task_due as
  select
    t.*,
    e.title as anchor_title,
    case
      when t.due_on is not null then t.due_on
      when e.date  is not null then e.date - coalesce(t.lead_days, 0)
    end as effective_due,
    (t.done_on is null
     and case
       when t.due_on is not null then t.due_on
       when e.date  is not null then e.date - coalesce(t.lead_days, 0)
     end < current_date) as overdue
  from tasks t
  left join events e on e.id = t.anchor_event_id;

-- ---------------------------------------------------------------------------
-- playbook — the handover, made queryable and regenerable
-- ---------------------------------------------------------------------------
-- Section VII exists because nothing else remembered. Entries accumulate all
-- year and export as next year's handover document.

create table if not exists playbook (
  id           uuid primary key default gen_random_uuid(),
  section      text not null,               -- 'freshers','money','nasta','societies','kit','safeguarding'
  title        text not null,
  body         text not null,
  -- Which year's manager wrote it, so next year can weigh advice by recency.
  written_by   uuid references members(id) on delete set null,
  academic_year text not null default '2026/27',
  -- Handover Ic/IIf: some entries are 'this is how it works' and some are
  -- 'this went wrong, do not repeat it'. They read differently.
  is_caution   boolean not null default false,
  event_id     uuid references events(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists playbook_section_idx on playbook (academic_year, section);

create table if not exists contacts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  org          text,                         -- 'SU','CampusTV','Rugby','NaSTA'
  role         text,                         -- 'Media Executive','Sports Officer'
  email        text,
  phone        text,
  what_for     text,                         -- 'finance codes, event planners, alumni fund'
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- money — charges out, spend in, and the windows that close
-- ---------------------------------------------------------------------------

create table if not exists ledger (
  id           uuid primary key default gen_random_uuid(),
  happened_on  date not null,
  description  text not null,
  amount_gbp   numeric(9,2) not null,        -- positive in, negative out
  category     text,                         -- 'event_fee','kit','merch','nasta','travel'
  event_id     uuid references events(id) on delete set null,
  -- Handover IIIa/IIIe: everything moves through an SU interactive form.
  form_ref     text,
  submitted_on date,
  settled_on   date,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Handover IIId: alumni fund opens around October/November and again in
-- January, and applying late means getting the money late. A window is not an
-- event — nothing is filmed — so it is its own small table.
create table if not exists funding_windows (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  opens_on     date,
  closes_on    date,
  applied_on   date,
  outcome      text,
  notes        text
);

-- ---------------------------------------------------------------------------
-- incidents — safeguarding
-- ---------------------------------------------------------------------------
-- Handover Vb: the station manager is the HR. Separate table, separate route,
-- not linked from the navigation, and never joined into any list view.

create table if not exists incidents (
  id           uuid primary key default gen_random_uuid(),
  happened_on  date not null,
  event_id     uuid references events(id) on delete set null,
  summary      text not null,
  action_taken text,
  reported_to  text,                         -- 'Helen','SU Media Exec'
  resolved_on  date,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Derived views — the questions each screen asks
-- ---------------------------------------------------------------------------

-- The calendar and the crew list both read this. Coverage is computed, never
-- stored, so it cannot drift out of step with the roles themselves.
create or replace view event_coverage as
  select
    e.id,
    e.title,
    e.date,
    e.strand,
    e.status,
    e.venue,
    count(r.id)                                   as roles_total,
    count(r.member_id)                            as roles_filled,
    count(r.id) - count(r.member_id)              as roles_open,
    (count(r.id) > 0 and count(r.id) = count(r.member_id)) as crew_complete
  from events e
  left join event_roles r on r.event_id = e.id
  where e.status <> 'cancelled'
  group by e.id;

-- One person, two places, same hours. The handover's other crew failure, and
-- the one nobody spots by eye. Self-join on member with an overlap test;
-- `r1.id < r2.id` stops each clash being reported twice.
create or replace view crew_clashes as
  select
    r1.member_id,
    m.known_as,
    e1.date,
    r1.id as role_a, e1.id as event_a, e1.title as event_a_title, r1.label as label_a,
    r2.id as role_b, e2.id as event_b, e2.title as event_b_title, r2.label as label_b
  from event_roles r1
  join event_roles r2
    on r1.member_id = r2.member_id
   and r1.id < r2.id
  join events e1 on e1.id = r1.event_id
  join events e2 on e2.id = r2.event_id
  join members m on m.id = r1.member_id
  where r1.member_id is not null
    and r1.on_site and r2.on_site
    and e1.date = e2.date
    and e1.status <> 'cancelled'
    and e2.status <> 'cancelled'
    -- Overlap, treating a missing time as "all day" so an untimed event still
    -- clashes rather than silently passing.
    and coalesce(r1.from_time, '00:00') < coalesce(r2.to_time, '23:59')
    and coalesce(r2.from_time, '00:00') < coalesce(r1.to_time, '23:59');

-- Out and not back. Run after every de-rig.
create or replace view kit_outstanding as
  select
    b.id as booking_id, k.id as kit_id, k.name, k.asset_tag, k.category,
    b.booked_for, b.out_at, e.title as event_title, m.known_as as taken_by
  from kit_bookings b
  join kit k on k.id = b.kit_id
  left join events e on e.id = b.event_id
  left join members m on m.id = b.out_by
  where b.out_at is not null and b.back_at is null;

-- Shot and not out, oldest first.
create or replace view post_outstanding as
  select
    d.*, e.title as event_title, e.date as event_date, m.known_as as editor,
    (d.due_on < current_date) as late,
    current_date - d.due_on   as days_late
  from deliverables d
  join events e on e.id = d.event_id
  left join members m on m.id = d.editor_id
  where d.posted_at is null;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists events_touch on events;
create trigger events_touch before update on events
  for each row execute function touch_updated_at();

-- Sync bookkeeping, part two: the triggers that keep `updated_at` honest.
-- The columns themselves are added further up, before task_due — see the note
-- there for why the order is load-bearing.
do $$
declare t text;
begin
  foreach t in array array[
    'members','societies','prep_templates','event_roles','tasks','kit'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before update on %I for each row execute function touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- Realtime. A poll every few seconds would converge too, and the client keeps
-- one as a fallback because a dropped socket must not mean stale crew lists.
-- But the case this product exists for is two people filling the same open role
-- at the same time, and that wants to resolve in a second, not on the next tick.
--
-- `add table` throws if the table is already published, and this file promises
-- to be re-runnable, so each one is guarded.
do $$
declare t text;
begin
  foreach t in array array[
    'members','societies','events','event_roles','tasks','prep_templates','kit',
    -- The board is collaborative too: a note or link someone else adds should
    -- appear without waiting for the poll. These tables are created earlier in
    -- this file, so they exist by the time the loop runs; the pg_publication_tables
    -- check below still skips any already published.
    'boards','board_nodes','board_edges'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
exception
  -- A bare Postgres (PGlite, under npm run verify:sql) has no supabase_realtime
  -- publication. The schema is still valid; there is just nothing to publish to.
  when undefined_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Accounts, roles and access — who can see and change what
-- ---------------------------------------------------------------------------
-- The calendar is public; everything else needs an account, and the private
-- modules (crew, to-do) need a grant on top. One account is the admin — the
-- station manager — who invites people and hands out per-module view/edit
-- grants, so the Calendar URL can stay public while crew details do not.
--
--   admins        emails that are admin on sight, seeded so the first admin
--                 exists the moment they sign up
--   profiles      one row per auth user, minted by a trigger on sign-up
--   access_grants what a non-admin may see or change, per module
--   invites       an admin-issued token; redeeming it on sign-up applies grants

create table if not exists admins (
  email text primary key
);
-- The station manager. Replace/extend before handing the tool to a new manager.
insert into admins (email) values ('willz.eze2023@gmail.com') on conflict do nothing;

create table if not exists profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Modules a grant can be issued over. Calendar/events are public and never
-- listed here; crew and tasks are private by default; kit and money can be
-- gated too when the admin chooses.
create table if not exists access_grants (
  user_id   uuid not null references auth.users(id) on delete cascade,
  module    text not null,
  can_view  boolean not null default true,
  can_edit  boolean not null default false,
  primary key (user_id, module)
);

create table if not exists invites (
  id         uuid primary key default gen_random_uuid(),
  token      text unique not null,
  email      text,
  is_admin   boolean not null default false,
  grants     jsonb not null default '[]'::jsonb,   -- [{module,can_view,can_edit}]
  created_by uuid references auth.users(id) on delete set null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- On sign-up: create the profile, promote to admin if the email is on the
-- admins list, and redeem an invite token passed in the sign-up metadata
-- (raw_user_meta_data.invite_token). No server needed — the token is the
-- capability, so an account created without one simply has no grants.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  tok text := new.raw_user_meta_data->>'invite_token';
  inv invites%rowtype;
  adm boolean := exists (select 1 from admins a where a.email = new.email);
  g   jsonb;
begin
  select * into inv from invites where token = tok and used_at is null;
  insert into profiles (user_id, email, is_admin)
  values (new.id, new.email, adm or coalesce(inv.is_admin, false))
  on conflict (user_id) do update set email = excluded.email;

  if inv.id is not null then
    for g in select jsonb_array_elements(inv.grants) loop
      insert into access_grants (user_id, module, can_view, can_edit)
      values (new.id, g->>'module',
              coalesce((g->>'can_view')::boolean, true),
              coalesce((g->>'can_edit')::boolean, false))
      on conflict (user_id, module) do update
        set can_view = excluded.can_view, can_edit = excluded.can_edit;
    end loop;
    update invites set used_at = now() where id = inv.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Access helpers, read by the policies below. SECURITY DEFINER so they can read
-- profiles/grants without tripping those tables' own RLS (and without recursing).
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.user_id = auth.uid() and p.is_admin);
$$;

create or replace function can_view(mod text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from access_grants g
    where g.user_id = auth.uid() and g.module = mod and g.can_view);
$$;

create or replace function can_edit(mod text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from access_grants g
    where g.user_id = auth.uid() and g.module = mod and g.can_edit);
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Reading is open with the publishable key. Writing needs a real session.
--
-- v1 was single-operator behind an unguessable URL. That stopped being the
-- shape of the problem once the site went up on a public host and more than one
-- person started editing it: the publishable key ships inside the page, so
-- "knows the URL" and "holds the key" are the same thing, and an unguessable
-- URL is not an access control. Anyone can still read the year — that is the
-- point of putting it on the web — but moving a fixture, filling a role or
-- ticking off a deadline now requires an account.
--
-- incidents remains stricter than everything else: safeguarding material is not
-- readable at all without a session, not merely unwritable.

alter table members         enable row level security;
alter table societies       enable row level security;
alter table events          enable row level security;
alter table event_roles     enable row level security;
alter table prep_items      enable row level security;
alter table prep_templates  enable row level security;
alter table kit             enable row level security;
alter table kit_bookings    enable row level security;
alter table deliverables    enable row level security;
alter table tasks           enable row level security;
alter table boards          enable row level security;
alter table board_nodes     enable row level security;
alter table board_edges     enable row level security;
alter table playbook        enable row level security;
alter table contacts        enable row level security;
alter table ledger          enable row level security;
alter table funding_windows enable row level security;
alter table incidents       enable row level security;

do $$
declare t text;
begin
  -- members and tasks are the private modules; they get grant-gated policies
  -- below and so are left out of this open-read loop.
  foreach t in array array[
    'societies','events','event_roles','prep_items','prep_templates',
    'kit','kit_bookings','deliverables','playbook','contacts','ledger',
    'funding_windows'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_read',  t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for select using (true)', t || '_read', t);
    execute format('create policy %I on %I for insert with check (auth.role() = ''authenticated'')',
                   t || '_write', t);
    execute format('create policy %I on %I for update using (auth.role() = ''authenticated'') '
                   'with check (auth.role() = ''authenticated'')', t || '_update', t);
  end loop;
end $$;

-- Deletion is allowed on exactly two tables, and refused everywhere else.
--
-- `events` and `tasks` are deletable because the 2026/27 year was reconstructed
-- from a handover document: most of it is inferred, some of it is guessed, and
-- the station manager has to be able to throw away a fixture that was never
-- real. Cancelling is for an event that existed and got called off — it keeps
-- the row, strikes it through, and is still the right action for that case.
--
-- Everything else has no DELETE policy on purpose. A kit booking, a ledger
-- line, a deliverable and an incident are records of something that happened,
-- and a record you can delete is a record you cannot rely on.
--
-- Crew and kit (members, kit) are the exception the station manager asked for:
-- they are the *register*, not a record of an event, and a committee that is
-- setting the station up for a new year needs to throw away the previous year's
-- roster and inventory and start clean — not carry a growing pile of inactive
-- rows forever. So both are deletable. A kit booking against a piece is still a
-- record and still not deletable; deleting the piece cascades its bookings
-- (kit_bookings.kit_id is ON DELETE CASCADE), and event_roles.member_id and the
-- other member FKs are ON DELETE SET NULL, so removing a person empties the
-- slots they held rather than deleting the events.
do $$
declare t text;
begin
  foreach t in array array['events', 'kit'] loop
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for delete using (auth.role() = ''authenticated'')',
                   t || '_delete', t);
  end loop;
end $$;

-- event_roles is deletable too, and it is the one addition the multi-client
-- move forced. Removing a role from an event is an edit the interface has
-- always offered; while the document lived in localStorage that was just a
-- shorter array, but against the database it has to be a DELETE or the role
-- comes back on the next pull. The record being protected here is the event,
-- and the event survives.
drop policy if exists event_roles_delete on event_roles;
create policy event_roles_delete on event_roles for delete
  using (auth.role() = 'authenticated');

-- prep_items is deletable for the same reason event_roles is. A per-event prep
-- step is a plan, editable on the event, and the sheet has always been able to
-- add and remove them; against a shared database that removal has to be a real
-- DELETE or the step comes back on the next pull. The record protected is the
-- event, and the event survives. (The reusable rule lives in prep_templates,
-- which is not deletable this way.)
drop policy if exists prep_items_delete on prep_items;
create policy prep_items_delete on prep_items for delete
  using (auth.role() = 'authenticated');

-- members (crew) and tasks are the private modules: read and write are gated by
-- a grant (or admin), not merely by having an account. This is what lets the
-- Calendar URL stay public while crew details and the to-do list do not.
do $$
declare t text;
begin
  foreach t in array array['members', 'tasks'] loop
    execute format('drop policy if exists %I on %I', t || '_read',   t);
    execute format('drop policy if exists %I on %I', t || '_write',  t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
  end loop;
end $$;

create policy members_read   on members for select using (can_view('crew'));
create policy members_write  on members for insert with check (can_edit('crew'));
create policy members_update on members for update using (can_edit('crew')) with check (can_edit('crew'));
-- Crew is deletable (see the deletion note above): a new committee clears the
-- roster and starts clean, gated by the same crew edit grant as every other write.
create policy members_delete on members for delete using (can_edit('crew'));

create policy tasks_read   on tasks for select using (can_view('tasks'));
create policy tasks_write  on tasks for insert with check (can_edit('tasks'));
create policy tasks_update on tasks for update using (can_edit('tasks')) with check (can_edit('tasks'));
create policy tasks_delete on tasks for delete using (can_edit('tasks'));

-- board is the third private module — the manager's brainstorming canvas. All
-- three tables read and write through the board grant, exactly like crew and the
-- to-do list, so the canvas stays off the public calendar URL. Every one is
-- deletable: a note or a link removed on the canvas has to be a real DELETE or
-- it comes back on the next pull, and a whole board is a scratchpad the manager
-- clears (the register reasoning that already applies to crew and kit).
do $$
declare t text;
begin
  foreach t in array array['boards', 'board_nodes', 'board_edges'] loop
    execute format('drop policy if exists %I on %I', t || '_read',   t);
    execute format('drop policy if exists %I on %I', t || '_write',  t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for select using (can_view(''board''))', t || '_read', t);
    execute format('create policy %I on %I for insert with check (can_edit(''board''))', t || '_write', t);
    execute format('create policy %I on %I for update using (can_edit(''board'')) '
                   'with check (can_edit(''board''))', t || '_update', t);
    execute format('create policy %I on %I for delete using (can_edit(''board''))', t || '_delete', t);
  end loop;
end $$;

-- The accounts tables. A user reads their own profile and grants so the client
-- knows what to show; the admin reads and writes everyone's, and issues invites.
alter table admins        enable row level security;
alter table profiles      enable row level security;
alter table access_grants enable row level security;
alter table invites       enable row level security;

drop policy if exists admins_read on admins;
create policy admins_read on admins for select using (is_admin());

drop policy if exists profiles_read on profiles;
drop policy if exists profiles_admin_upd on profiles;
create policy profiles_read      on profiles for select using (user_id = auth.uid() or is_admin());
create policy profiles_admin_upd on profiles for update using (is_admin()) with check (is_admin());

drop policy if exists access_read on access_grants;
drop policy if exists access_admin_ins on access_grants;
drop policy if exists access_admin_upd on access_grants;
drop policy if exists access_admin_del on access_grants;
create policy access_read      on access_grants for select using (user_id = auth.uid() or is_admin());
create policy access_admin_ins on access_grants for insert with check (is_admin());
create policy access_admin_upd on access_grants for update using (is_admin()) with check (is_admin());
create policy access_admin_del on access_grants for delete using (is_admin());

drop policy if exists invites_admin_all on invites;
create policy invites_admin_all on invites for all using (is_admin()) with check (is_admin());

-- incidents: authenticated only, both directions.
drop policy if exists incidents_read on incidents;
drop policy if exists incidents_write on incidents;
create policy incidents_read  on incidents for select
  using (auth.role() = 'authenticated');
create policy incidents_write on incidents for insert
  with check (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- Storage — kit photos
-- ---------------------------------------------------------------------------
-- A public bucket so a phone reading the locker shows the same picture as the
-- laptop that uploaded it. Reads are open (public bucket); writing an object
-- needs a session, mirroring the tables. Wrapped in a guarded block because a
-- bare Postgres (PGlite, under npm run verify:sql) has no storage schema — the
-- rest of the schema is still valid there, there is just nowhere to put a file.
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('kit-photos', 'kit-photos', true)
  on conflict (id) do nothing;

  drop policy if exists kit_photos_read on storage.objects;
  drop policy if exists kit_photos_write on storage.objects;
  drop policy if exists kit_photos_update on storage.objects;
  create policy kit_photos_read on storage.objects for select
    using (bucket_id = 'kit-photos');
  create policy kit_photos_write on storage.objects for insert
    with check (bucket_id = 'kit-photos' and auth.role() = 'authenticated');
  create policy kit_photos_update on storage.objects for update
    using (bucket_id = 'kit-photos' and auth.role() = 'authenticated');
exception
  -- No storage schema (PGlite under verify:sql) or no privilege to touch it:
  -- the rest of the schema is valid, there is just nowhere to put a file.
  when others then null;
end $$;
