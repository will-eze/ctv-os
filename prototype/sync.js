// CTV OS — multi-client sync.
//
// Inlined into the page by scripts/build_prototype.py. Not loaded over the
// network: the CSP forbids external scripts, and a station manager on a phone
// at the Rec at midnight should not be waiting on a CDN.
//
// ---------------------------------------------------------------------------
// The shape of the problem
// ---------------------------------------------------------------------------
// The prototype kept the whole year as one nested document in localStorage and
// wrote all of it on every edit. That is exactly right for one person and
// exactly wrong for several: two people editing different events would clobber
// each other, because the unit of writing was the entire year.
//
// So the document stays — every render path, coverage(), findClashes(), the
// month grid and all 39 e2e checks read `DATA` and know nothing about any of
// this — and the unit of *writing* becomes the row.
//
// mutate() already cloned the document before every change so that undo could
// restore it. That clone is the other half of a diff. Comparing before against
// after yields the handful of rows that actually changed, and those are what
// go to Postgres. One choke point, thirteen call sites, none of them touched.
//
// Convergence, concretely:
//   - two clients editing different events never conflict, because they write
//     disjoint rows;
//   - two clients editing the same field, last write wins, and the loser sees
//     the winner's value within a second via Realtime;
//   - a dropped socket degrades to a poll, not to stale data;
//   - no network at all degrades to localStorage, which is where this started.
//
// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
// Events and tasks are addressed by slug ('ww-fri', 'outlook') because that is
// what data/year.json calls them and what the export has to round-trip. The
// database mints the uuid; the slug is the unique key the client writes against.
//
// Roles are addressed by uuid, generated on the client at the moment the role
// is added. They have no natural name — the interface has always addressed them
// by array position, and a position is not an identity when someone else can
// insert one. This is the one place the document gained a field.

const Sync = (() => {
  // __SUPABASE__ is replaced at build time with {url, key} or with null when
  // no project is configured. A build with no project produces exactly the
  // local-only prototype that came before, which is what e2e drives.
  const CFG = __SUPABASE__;

  const SESSION_KEY = 'ctvos.session.v1';
  const OUTBOX_KEY = 'ctvos.outbox.v1';
  const POLL_MS = 20000;

  // Tables pulled to build the document. Order matters: societies and members
  // must land before events, because roles resolve member slugs against them.
  const PULL = [
    'societies', 'members', 'prep_templates',
    'events', 'event_roles', 'prep_items', 'deliverables', 'tasks', 'kit',
    'boards', 'board_nodes', 'board_edges',
  ];

  // The board is a later addition, so a live project that has not had the new
  // migration pushed yet does not have these three tables. Their absence must
  // not take the whole app offline — the calendar is public and has to keep
  // working — so a pull tolerates them 404ing and treats the canvas as empty
  // until the migration lands. Every other table is load-bearing and still throws.
  const OPTIONAL_TABLES = new Set(['boards', 'board_nodes', 'board_edges']);

  let session = null;      // { access_token, refresh_token, expires_at, user }
  let hooks = {};          // { getDoc, setDoc, onStatus }
  let socket = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let refreshTimer = null;
  let pulling = false;
  let pullAgain = false;
  let status = { mode: CFG ? 'connecting' : 'local', signedIn: false, error: null };

  const enabled = () => Boolean(CFG && CFG.url && CFG.key);

  // --- Status ---------------------------------------------------------------
  // Every state this reports is rendered as words, never as a colour alone —
  // the one rule that outlived the redesign. See renderSyncStatus in the
  // template and the four assertions in scripts/shots.mjs.
  function setStatus(patch) {
    status = { ...status, ...patch };
    hooks.onStatus?.(status);
  }

  // --- HTTP -----------------------------------------------------------------
  // A hand-written PostgREST client rather than supabase-js. The library is
  // ~50 KB minified and would have to be vendored into the page to survive the
  // CSP; what is actually needed is six verbs over fetch.
  async function rest(path, opts = {}) {
    if (!enabled()) throw new Error('no project configured');
    const headers = {
      apikey: CFG.key,
      Authorization: `Bearer ${session?.access_token || CFG.key}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    };
    const res = await fetch(`${CFG.url}/rest/v1/${path}`, { ...opts, headers });
    if (res.status === 401 && session) {
      // The access token expired between the refresh timer firing and now.
      // One retry, then give up and let the caller queue the write.
      if (await refresh()) return rest(path, opts);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${path.split('?')[0]}: ${body.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // --- Auth (GoTrue) --------------------------------------------------------
  // Reads are open with the publishable key; writes need a session. See the
  // row-level security section of supabase/schema.sql for why that changed.
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) session = JSON.parse(raw);
    } catch { /* corrupt session is no session */ }
  }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* private mode: the session lasts as long as the tab */ }
    setStatus({ signedIn: Boolean(s), user: s?.user?.email ?? null });
    if (!s) setStatus({ isAdmin: false, grants: {}, account: null });
    scheduleRefresh();
    // The socket carries the token for RLS, so a sign-in or sign-out has to
    // re-handshake rather than keep talking with the old identity.
    if (socket) { try { socket.close(); } catch { /* already gone */ } }
  }

  async function token(body) {
    const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=${body.grant_type}`, {
      method: 'POST',
      headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.msg || `sign-in failed (${res.status})`);
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
      user: json.user,
    };
  }

  async function signIn(email, password) {
    const s = await token({ grant_type: 'password', email, password });
    saveSession(s);
    await pull();
    await loadAccess();
    await drainOutbox();
    return s;
  }

  // Sign up against an invite. The token rides in the sign-up metadata; a
  // trigger on the database redeems it and applies the admin's grants. No secret
  // key touches the page — the token is the capability.
  async function signUp(email, password, inviteToken) {
    const res = await fetch(`${CFG.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, data: inviteToken ? { invite_token: inviteToken } : {} }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.msg || `sign-up failed (${res.status})`);
    if (json.access_token) {
      saveSession({
        access_token: json.access_token, refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in ?? 3600) * 1000, user: json.user,
      });
      await pull(); await loadAccess(); await drainOutbox();
    }
    return json;   // no access_token => email confirmation is on; caller says so
  }

  // --- Password recovery ----------------------------------------------------
  // Ask GoTrue to email a reset link. redirect_to is *this page* so the link
  // lands back in the app instead of Supabase's default Site URL — which is
  // http://localhost:3000 out of the box and is why a fresh project's reset
  // emails 'refuse to connect'. The URL still has to be on the project's
  // Auth → Redirect URLs allow-list, or GoTrue falls back to the Site URL.
  async function recover(email) {
    const redirect_to = location.origin + location.pathname;
    const res = await fetch(
      `${CFG.url}/auth/v1/recover?redirect_to=${encodeURIComponent(redirect_to)}`, {
        method: 'POST',
        headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error_description || json.msg || `reset failed (${res.status})`);
    }
  }

  // The reset link drops back here with a recovery session in the URL hash (see
  // adoptUrlSession). This turns that one-time session into a permanent one by
  // setting the new password, then behaves exactly like a fresh sign-in.
  async function updatePassword(password) {
    if (!session) throw new Error('no recovery session');
    const res = await fetch(`${CFG.url}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: CFG.key,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.msg || `could not set password (${res.status})`);
    saveSession({ ...session, user: json });
    setStatus({ recovery: false });
    await pull();
    await loadAccess();
    await drainOutbox();
  }

  // A reset (or confirmation) link returns here with the session in the URL
  // fragment: #access_token=…&type=recovery&… . Adopt it as the live session so
  // the password can be changed, and scrub the tokens out of the address bar so
  // a reload or a shared URL doesn't carry a live credential.
  function adoptUrlSession() {
    if (typeof location === 'undefined' || !location.hash) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    const access_token = p.get('access_token');
    if (!access_token || p.get('type') !== 'recovery') return false;
    saveSession({
      access_token,
      refresh_token: p.get('refresh_token'),
      expires_at: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
      user: null,
    });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  // What the signed-in account is allowed to see and change — the admin flag and
  // the per-module grants. Read straight after a pull and folded into the status
  // the interface renders its gates from.
  async function loadAccess() {
    if (!session) { setStatus({ isAdmin: false, grants: {}, account: null }); return; }
    const uid = session.user?.id;
    try {
      const [prof, grants] = await Promise.all([
        rest(`profiles?user_id=eq.${uid}&select=is_admin,email`),
        rest(`access_grants?user_id=eq.${uid}&select=module,can_view,can_edit`),
      ]);
      const gmap = {};
      for (const g of grants) gmap[g.module] = { view: g.can_view, edit: g.can_edit };
      setStatus({
        isAdmin: Boolean(prof[0]?.is_admin), grants: gmap,
        account: prof[0]?.email ?? session.user?.email ?? null,
      });
    } catch {
      setStatus({ isAdmin: false, grants: {}, account: session.user?.email ?? null });
    }
  }

  // --- Admin: accounts, invites and grants ----------------------------------
  async function listAccounts() {
    const [profiles, grants] = await Promise.all([
      rest('profiles?select=user_id,email,is_admin&order=email'),
      rest('access_grants?select=user_id,module,can_view,can_edit'),
    ]);
    return { profiles, grants };
  }

  async function createInvite({ email = null, is_admin = false, grants = [] }) {
    const token = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, '');
    const rows = await rest('invites', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ token, email, is_admin, grants, created_by: session?.user?.id ?? null }]),
    });
    return rows[0];
  }

  async function setGrant(userId, module, can_view, can_edit) {
    if (!can_view && !can_edit) {
      await rest(`access_grants?user_id=eq.${userId}&module=eq.${encodeURIComponent(module)}`,
        { method: 'DELETE' });
      return;
    }
    await rest('access_grants?on_conflict=user_id,module', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: userId, module, can_view, can_edit }]),
    });
  }

  async function signOut() {
    try {
      if (session) {
        await fetch(`${CFG.url}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: CFG.key, Authorization: `Bearer ${session.access_token}` },
        });
      }
    } catch { /* signing out locally is what matters */ }
    saveSession(null);
    connect();
  }

  async function refresh() {
    if (!session?.refresh_token) return false;
    try {
      saveSession(await token({ grant_type: 'refresh_token', refresh_token: session.refresh_token }));
      return true;
    } catch {
      // A refresh token that no longer works means the session is over. Say so
      // rather than leaving the page looking editable when it is not.
      saveSession(null);
      setStatus({ error: 'Session expired — sign in again' });
      return false;
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session) return;
    // A minute of margin, and never less than five seconds, so a token that is
    // already stale refreshes now instead of scheduling into the past.
    const due = Math.max(5000, session.expires_at - Date.now() - 60000);
    refreshTimer = setTimeout(refresh, due);
  }

  // --- Document <-> rows ----------------------------------------------------
  // data/year.json's nested shape is what the interface renders. The database
  // is normalised. These two functions are the entire translation, and they are
  // the only place that knows both shapes.
  const nz = (v) => (v === '' || v === undefined ? null : v);
  const hhmm = (t) => (t ? String(t).slice(0, 5) : null);   // '22:30:00' -> '22:30'

  function toDocument(rows) {
    const socById = new Map(rows.societies.map((s) => [s.id, s]));
    const memById = new Map(rows.members.map((m) => [m.id, m]));
    const evById = new Map(rows.events.map((e) => [e.id, e]));

    const rolesByEvent = new Map();
    for (const r of [...rows.event_roles].sort((a, b) => a.sort_order - b.sort_order)) {
      if (!rolesByEvent.has(r.event_id)) rolesByEvent.set(r.event_id, []);
      rolesByEvent.get(r.event_id).push({
        id: r.id,
        label: r.label,
        role: r.role,
        member: r.member_id ? (memById.get(r.member_id)?.slug ?? null) : null,
        from: hhmm(r.from_time),
        to: hhmm(r.to_time),
        on_site: r.on_site,
      });
    }

    const nest = (list, key, map) => {
      const out = new Map();
      for (const row of list) {
        if (!out.has(row.event_id)) out.set(row.event_id, []);
        out.get(row.event_id).push(map(row));
      }
      return out;
    };
    // Sorted by sort_order so the sheet lists prep the way it was arranged, and
    // carrying the uuid so an edit in the sheet diffs against the right row
    // rather than delete-and-recreating the list.
    const prepByEvent = nest(
      [...(rows.prep_items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
      'event_id', (p) => ({
        id: p.id, label: p.label, lead_days: p.lead_days, owner_role: p.owner_role, detail: p.detail,
        // The FK comes back as a uuid; the document addresses events by slug.
        event_ref: p.event_ref ? (evById.get(p.event_ref)?.slug ?? null) : undefined,
      }));
    const delByEvent = nest(rows.deliverables, 'event_id', (d) => ({
      title: d.title, kind: d.kind, due_offset: d.due_offset ?? 1,
      nasta_category: d.nasta_category ?? undefined,
    }));

    return {
      members: rows.members.map((m) => ({
        id: m.slug, known_as: m.known_as, full_name: m.full_name,
        committee_role: m.committee_role, trained: m.trained ?? [],
        active: m.active !== false,
      })),
      societies: rows.societies.map((s) => ({
        id: s.slug, name: s.name, standing_terms: s.standing_terms,
        cautions: s.cautions, charge_policy: s.charge_policy,
      })),
      prep_templates: rows.prep_templates.map((p) => ({
        // NULL is the table's way of saying every strand; the interface
        // matches on "*", so it is translated back on the way out.
        strand: p.strand ?? '*', label: p.label, lead_days: p.lead_days,
        owner_role: p.owner_role, detail: p.detail,
      })),
      events: [...rows.events]
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map((e) => ({
          id: e.slug,
          title: e.title,
          date: e.date,
          strand: e.strand,
          status: e.status,
          confidence: e.date_confidence,
          venue: e.venue,
          call_time: hhmm(e.call_time),
          doors_time: hhmm(e.doors_time),
          start_time: hhmm(e.start_time),
          end_time: hhmm(e.end_time),
          brief: e.brief,
          society: e.society_id ? (socById.get(e.society_id)?.slug ?? null) : undefined,
          kit_needed: e.kit_needed ?? [],
          prep_skip: e.prep_skip ?? [],
          roles: rolesByEvent.get(e.id) ?? [],
          prep: prepByEvent.get(e.id) ?? undefined,
          deliverables: delByEvent.get(e.id) ?? undefined,
        })),
      tasks: [...rows.tasks]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((t) => ({
          id: t.slug,
          title: t.title, detail: t.detail, area: t.area, source: t.source,
          owner_role: t.owner_role,
          anchor: t.anchor_event_id ? (evById.get(t.anchor_event_id)?.slug ?? null) : null,
          lead_days: t.lead_days,
          due: t.due_on,
          done: t.done_on !== null,
        })),
      // Kit is a deletable register now, so an empty table is an empty locker,
      // not "not seeded yet" — it is mapped verbatim like members, blanks and
      // all. (The genuinely-unseeded project is caught upstream by pull()'s
      // events-length guard, which bails before ever reaching here.) Identity is
      // the slug, mirroring events and members.
      kit: (rows.kit ?? []).map((k) => ({
        id: k.slug ?? k.asset_tag ?? k.id,
        name: k.name, category: k.category, asset_tag: k.asset_tag, owner: k.owner,
        state: k.state, home: k.home, notes: k.notes,
        usage: k.usage, tips: k.tips, photo_url: k.photo_url,
      })),
      // The board, nested back into the shape the canvas renders: each board
      // carries its own notes and links. Notes come out in sort_order; a link
      // names its endpoints by note slug, the same id the canvas uses.
      boards: (() => {
        const nodesBy = new Map(), edgesBy = new Map();
        for (const n of [...(rows.board_nodes ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
          (nodesBy.get(n.board_id) ?? nodesBy.set(n.board_id, []).get(n.board_id))
            .push({ id: n.slug, x: n.x, y: n.y, body: n.body, color: n.color });
        }
        for (const e of rows.board_edges ?? []) {
          (edgesBy.get(e.board_id) ?? edgesBy.set(e.board_id, []).get(e.board_id))
            .push({ id: e.slug, from: e.from_node, to: e.to_node });
        }
        return [...(rows.boards ?? [])]
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((b) => ({ id: b.slug, name: b.name, nodes: nodesBy.get(b.id) ?? [], edges: edgesBy.get(b.id) ?? [] }));
      })(),
    };
  }

  const eventRow = (e) => ({
    slug: e.id,
    title: e.title,
    date: e.date,
    strand: e.strand || 'society',
    status: e.status || 'planned',
    date_confidence: e.confidence || 'estimated',
    venue: nz(e.venue),
    call_time: nz(e.call_time),
    doors_time: nz(e.doors_time),
    start_time: nz(e.start_time),
    end_time: nz(e.end_time),
    brief: nz(e.brief),
    // The kit an event needs rides on the event row as jsonb — a short list of
    // {id, qty} against kit slugs. Small, event-scoped, and it travels with the
    // same events upsert/update the rest of the sheet already writes.
    kit_needed: e.kit_needed ?? [],
    // Template steps this event has opted out of, by label. Rides on the event
    // row like kit_needed.
    prep_skip: e.prep_skip ?? [],
  });

  const taskRow = (t) => ({
    slug: t.id,
    title: t.title,
    detail: nz(t.detail),
    area: t.area,
    source: nz(t.source),
    owner_role: nz(t.owner_role),
    due_on: nz(t.due),
    lead_days: t.anchor ? t.lead_days : null,
    // The document says done/not-done; the table records when. There is no
    // honest date to invent for a box someone ticked, so it is today — which is
    // also what makes `overdue` in the task_due view mean anything.
    done_on: t.done ? new Date().toISOString().slice(0, 10) : null,
  });

  const memberRow = (m) => ({
    slug: m.id,
    known_as: m.known_as,
    full_name: m.full_name ?? m.known_as,
    committee_role: nz(m.committee_role),
    trained: m.trained ?? [],
    active: m.active !== false,
  });

  const kitRow = (k) => ({
    slug: k.id,
    name: k.name,
    category: nz(k.category),
    asset_tag: nz(k.asset_tag),
    owner: k.owner || 'ctv',
    state: k.state || 'in_hub',
    home: nz(k.home),
    notes: nz(k.notes),
    usage: nz(k.usage),
    tips: nz(k.tips),
    photo_url: nz(k.photo_url),
  });

  const roleRow = (r, eventId, i) => ({
    id: r.id,
    event_id: eventId,
    label: r.label,
    role: nz(r.role),
    from_time: nz(r.from),
    to_time: nz(r.to),
    on_site: r.on_site !== false,
    sort_order: i,
  });

  // A per-event prep step. Keyed by uuid like a role, so adding or removing one
  // in the sheet is an insert/delete against prep_items and not a rewrite of the
  // whole list. The template lines the sheet also shows are the strand-wide rule
  // in prep_templates; they are never in e.prep and so never reach this row.
  const prepRow = (p, i) => ({
    id: p.id,
    label: p.label,
    detail: nz(p.detail),
    lead_days: p.lead_days ?? 0,
    owner_role: nz(p.owner_role),
    sort_order: i,
  });

  // Board rows. A board is keyed by slug like an event; a note and a link are
  // keyed by their own slug and resolved to the owning board at flush, exactly
  // like a role or a prep step resolves to its event.
  const boardRow = (b, i) => ({ slug: b.id, name: b.name, sort_order: i });
  const boardNodeRow = (n, i) => ({
    slug: n.id, x: n.x ?? 0, y: n.y ?? 0,
    body: n.body ?? '', color: n.color || 'grey', sort_order: i,
  });
  const boardEdgeRow = (e) => ({ slug: e.id, from_node: e.from, to_node: e.to });

  // --- Pull -----------------------------------------------------------------
  // The whole year, every time, rather than rows changed since a watermark.
  //
  // A watermark is the obvious optimisation and it is wrong here: it cannot see
  // a DELETE. Someone else removing a fixture would leave it on your calendar
  // until you reloaded, and a calendar showing an event nobody is running is
  // the exact failure this product exists to prevent. Comparing full id sets
  // to find the deletions costs a query of the same size as just fetching
  // everything, because an academic year is ~31 events and ~56 tasks. It is
  // about 60 KB. When that stops being true, this is the function to revisit.
  // A pull is the database's whole truth — but the outbox holds writes this
  // client has made and not yet flushed. Without this, a pull that lands between
  // a local delete and its DELETE reaching Postgres would put the deleted row
  // straight back on screen (and it would sit there until the delete's own
  // Realtime echo triggered another pull). So the still-pending deletes are
  // subtracted from the incoming document before it is shown: what you removed
  // stays removed until the server has actually caught up.
  // The mirror of the delete case: a register item this client just *added*
  // (kit or crew) lives in the outbox until its insert reaches Postgres. A pull
  // that lands in that window — a realtime reconnect, a poll — carries the
  // database's truth, which does not yet include the new row, so applyRemote
  // would drop it and the open sheet would slam shut a second after you clicked
  // Add. Re-inject any still-pending insert the incoming document is missing, so
  // what you added stays until the server has actually caught up.
  function reinjectPending(doc) {
    for (const op of readOutbox()) {
      if (op.op !== 'upsert') continue;
      const r = op.row;
      if (op.table === 'kit') {
        doc.kit ??= [];
        if (!doc.kit.some((k) => k.id === r.slug)) {
          doc.kit.push({
            id: r.slug, name: r.name, category: r.category, asset_tag: r.asset_tag,
            owner: r.owner, state: r.state, home: r.home, notes: r.notes,
            usage: r.usage, tips: r.tips, photo_url: r.photo_url,
          });
        }
      } else if (op.table === 'members') {
        doc.members ??= [];
        if (!doc.members.some((m) => m.id === r.slug)) {
          doc.members.push({
            id: r.slug, known_as: r.known_as, full_name: r.full_name,
            committee_role: r.committee_role, trained: r.trained ?? [], active: r.active !== false,
          });
        }
      }
    }
    return doc;
  }

  function reconcilePending(doc) {
    for (const op of readOutbox()) {
      if (op.op !== 'delete') continue;
      const key = op.by.match(/=eq\.(.+)$/)?.[1];
      if (!key) continue;
      if (op.table === 'events') doc.events = (doc.events ?? []).filter((e) => e.id !== key);
      else if (op.table === 'tasks') doc.tasks = (doc.tasks ?? []).filter((t) => t.id !== key);
      else if (op.table === 'members') doc.members = (doc.members ?? []).filter((m) => m.id !== key);
      else if (op.table === 'kit') doc.kit = (doc.kit ?? []).filter((k) => k.id !== key);
      else if (op.table === 'event_roles')
        for (const e of doc.events ?? []) e.roles = (e.roles ?? []).filter((r) => r.id !== key);
      else if (op.table === 'prep_items')
        for (const e of doc.events ?? []) if (e.prep) e.prep = e.prep.filter((p) => p.id !== key);
      else if (op.table === 'boards') doc.boards = (doc.boards ?? []).filter((b) => b.id !== key);
      else if (op.table === 'board_nodes')
        for (const b of doc.boards ?? []) b.nodes = (b.nodes ?? []).filter((n) => n.id !== key);
      else if (op.table === 'board_edges')
        for (const b of doc.boards ?? []) b.edges = (b.edges ?? []).filter((e) => e.id !== key);
    }
    return doc;
  }

  async function pull() {
    if (!enabled()) return null;
    if (pulling) { pullAgain = true; return null; }
    pulling = true;
    try {
      const rows = {};
      await Promise.all(PULL.map(async (t) => {
        try { rows[t] = await rest(`${t}?select=*`); }
        catch (err) { if (OPTIONAL_TABLES.has(t)) rows[t] = []; else throw err; }
      }));
      if (!rows.events.length) {
        // An empty database is not an empty year. Refusing to overwrite the
        // seed here is what makes it safe to point the page at a project
        // before anyone has run the seed script.
        setStatus({ mode: 'empty', error: 'Database is reachable but empty — run npm run seed' });
        return null;
      }
      const doc = reinjectPending(reconcilePending(toDocument(rows)));
      hooks.setDoc?.(doc);
      setStatus({ mode: 'synced', error: null, at: Date.now() });
      return doc;
    } catch (err) {
      setStatus({ mode: 'offline', error: String(err.message || err) });
      return null;
    } finally {
      pulling = false;
      if (pullAgain) { pullAgain = false; pull(); }
    }
  }

  // --- Push -----------------------------------------------------------------
  // Diff two documents, write only what moved.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function diff(before, after) {
    const ops = [];
    const index = (list) => new Map((list ?? []).map((x) => [x.id, x]));

    // Members. The crew directory is editable — names, committee roles and what
    // someone is trained on — and now deletable: a new committee clears the
    // previous year's roster and starts clean. So members diff like events and
    // tasks, deletion included. Removing a person nulls the roles they held
    // (member_id is ON DELETE SET NULL), which is exactly an unassigned slot.
    const mA = index(before.members), mB = index(after.members);
    for (const [id, m] of mB) {
      const was = mA.get(id);
      if (!was) ops.push({ table: 'members', op: 'upsert', on: 'slug', row: memberRow(m) });
      else if (!same(memberRow(was), memberRow(m))) {
        ops.push({ table: 'members', op: 'update', by: `slug=eq.${id}`, row: memberRow(m) });
      }
    }
    for (const id of mA.keys()) {
      if (!mB.has(id)) ops.push({ table: 'members', op: 'delete', by: `slug=eq.${id}` });
    }

    // Kit. Editable — details, usage notes, tips, photo — and deletable, for the
    // same reason as crew: the locker is a register a committee resets. Deleting a
    // piece cascades its bookings in the schema; here it is just gone from the list.
    const kA = index(before.kit), kB = index(after.kit);
    for (const [id, k] of kB) {
      const was = kA.get(id);
      if (!was) ops.push({ table: 'kit', op: 'upsert', on: 'slug', row: kitRow(k) });
      else if (!same(kitRow(was), kitRow(k))) {
        ops.push({ table: 'kit', op: 'update', by: `slug=eq.${id}`, row: kitRow(k) });
      }
    }
    for (const id of kA.keys()) {
      if (!kB.has(id)) ops.push({ table: 'kit', op: 'delete', by: `slug=eq.${id}` });
    }

    // Events
    const evA = index(before.events), evB = index(after.events);
    for (const [id, e] of evB) {
      const was = evA.get(id);
      if (!was) ops.push({ table: 'events', op: 'upsert', on: 'slug', row: eventRow(e) });
      else if (!same(eventRow(was), eventRow(e))) {
        ops.push({ table: 'events', op: 'update', by: `slug=eq.${id}`, row: eventRow(e) });
      }
    }
    for (const id of evA.keys()) {
      if (!evB.has(id)) ops.push({ table: 'events', op: 'delete', by: `slug=eq.${id}` });
    }

    // Roles. Keyed by uuid, so a role that moved position is an update to
    // sort_order and not a delete-and-recreate that would drop its crew.
    const rolesOf = (doc) => {
      const m = new Map();
      for (const e of doc.events ?? []) {
        (e.roles ?? []).forEach((r, i) => { if (r.id) m.set(r.id, { r, i, event: e.id }); });
      }
      return m;
    };
    const rA = rolesOf(before), rB = rolesOf(after);
    for (const [id, { r, i, event }] of rB) {
      const was = rA.get(id);
      // The event's uuid is not known to the client, so roles are written
      // through a slug lookup the caller resolves at flush time.
      const payload = { ...roleRow(r, null, i), _event_slug: event, _member_slug: r.member ?? null };
      if (!was) ops.push({ table: 'event_roles', op: 'upsert', on: 'id', row: payload });
      else if (!same({ ...roleRow(was.r, null, was.i), m: was.r.member }, { ...roleRow(r, null, i), m: r.member })) {
        ops.push({ table: 'event_roles', op: 'update', by: `id=eq.${id}`, row: payload });
      }
    }
    for (const id of rA.keys()) {
      if (!rB.has(id)) ops.push({ table: 'event_roles', op: 'delete', by: `id=eq.${id}` });
    }

    // Prep items. Same shape as roles: keyed by uuid, resolved to their event
    // through a slug lookup at flush time, and deletable — a prep step removed
    // in the sheet has to be a real DELETE or it returns on the next pull.
    const prepOf = (doc) => {
      const m = new Map();
      for (const e of doc.events ?? []) {
        (e.prep ?? []).forEach((p, i) => { if (p.id) m.set(p.id, { p, i, event: e.id }); });
      }
      return m;
    };
    const pA = prepOf(before), pB = prepOf(after);
    for (const [id, { p, i, event }] of pB) {
      const was = pA.get(id);
      // _event_slug is the owning event; _ref_slug is the optional event this
      // step links to. Both are resolved to uuids at flush. The link is folded
      // into the change comparison so re-pointing a step is seen as a change.
      const payload = { ...prepRow(p, i), _event_slug: event, _ref_slug: p.event_ref ?? null };
      if (!was) ops.push({ table: 'prep_items', op: 'upsert', on: 'id', row: payload });
      else if (!same({ ...prepRow(was.p, was.i), r: was.p.event_ref ?? null },
                     { ...prepRow(p, i), r: p.event_ref ?? null })) {
        ops.push({ table: 'prep_items', op: 'update', by: `id=eq.${id}`, row: payload });
      }
    }
    for (const id of pA.keys()) {
      if (!pB.has(id)) ops.push({ table: 'prep_items', op: 'delete', by: `id=eq.${id}` });
    }

    // Tasks
    const tA = index(before.tasks), tB = index(after.tasks);
    for (const [id, t] of tB) {
      const was = tA.get(id);
      const payload = { ...taskRow(t), _anchor_slug: t.anchor ?? null };
      if (!was) ops.push({ table: 'tasks', op: 'upsert', on: 'slug', row: payload });
      else if (!same({ ...taskRow(was), a: was.anchor }, { ...taskRow(t), a: t.anchor })) {
        // done_on is stamped with today's date, so an unchanged done task must
        // not look changed on every diff. Compare the flag, not the stamp.
        ops.push({ table: 'tasks', op: 'update', by: `slug=eq.${id}`, row: payload });
      }
    }
    for (const id of tA.keys()) {
      if (!tB.has(id)) ops.push({ table: 'tasks', op: 'delete', by: `slug=eq.${id}` });
    }

    // Board. Boards diff by slug like events; a rename is the only field-change
    // worth a write, so the change test compares the name and lets sort_order
    // ride along in the payload. Notes and links are keyed by their own slug and
    // carry the owning board's slug, resolved to a uuid at flush. All deletable.
    const boardsA = index(before.boards), boardsB = index(after.boards);
    let bi = 0;
    for (const [id, b] of boardsB) {
      const was = boardsA.get(id);
      if (!was) ops.push({ table: 'boards', op: 'upsert', on: 'slug', row: boardRow(b, bi) });
      else if (was.name !== b.name) ops.push({ table: 'boards', op: 'update', by: `slug=eq.${id}`, row: boardRow(b, bi) });
      bi++;
    }
    for (const id of boardsA.keys()) {
      if (!boardsB.has(id)) ops.push({ table: 'boards', op: 'delete', by: `slug=eq.${id}` });
    }

    const nodesOf = (doc) => {
      const m = new Map();
      for (const b of doc.boards ?? []) (b.nodes ?? []).forEach((n, i) => { if (n.id) m.set(n.id, { n, i, board: b.id }); });
      return m;
    };
    const nA = nodesOf(before), nB = nodesOf(after);
    for (const [id, { n, i, board }] of nB) {
      const was = nA.get(id);
      const payload = { ...boardNodeRow(n, i), _board_slug: board };
      if (!was) ops.push({ table: 'board_nodes', op: 'upsert', on: 'slug', row: payload });
      else if (!same(boardNodeRow(was.n, was.i), boardNodeRow(n, i))) {
        ops.push({ table: 'board_nodes', op: 'update', by: `slug=eq.${id}`, row: payload });
      }
    }
    for (const id of nA.keys()) {
      if (!nB.has(id)) ops.push({ table: 'board_nodes', op: 'delete', by: `slug=eq.${id}` });
    }

    const edgesOf = (doc) => {
      const m = new Map();
      for (const b of doc.boards ?? []) (b.edges ?? []).forEach((e) => { if (e.id) m.set(e.id, { e, board: b.id }); });
      return m;
    };
    const egA = edgesOf(before), egB = edgesOf(after);
    for (const [id, { e, board }] of egB) {
      const was = egA.get(id);
      const payload = { ...boardEdgeRow(e), _board_slug: board };
      if (!was) ops.push({ table: 'board_edges', op: 'upsert', on: 'slug', row: payload });
      else if (!same(boardEdgeRow(was.e), boardEdgeRow(e))) {
        ops.push({ table: 'board_edges', op: 'update', by: `slug=eq.${id}`, row: payload });
      }
    }
    for (const id of egA.keys()) {
      if (!egB.has(id)) ops.push({ table: 'board_edges', op: 'delete', by: `slug=eq.${id}` });
    }

    return ops;
  }

  // Slug -> uuid, for the three foreign keys the document carries as names.
  // Cached from the last pull and refreshed on a miss, because a role can be
  // assigned to a member this client has never seen before.
  let idmap = { events: new Map(), members: new Map(), boards: new Map() };

  async function resolve(kind, slug) {
    if (slug == null) return null;
    // A missing bucket must never throw here: a TypeError is not a 4xx, so it is
    // treated as "the network" and wedges the whole outbox behind it forever —
    // which is exactly how one queued board edit silently stopped every other
    // change from persisting. Materialise the bucket instead of trusting init().
    if (!idmap[kind]) idmap[kind] = new Map();
    if (idmap[kind].has(slug)) return idmap[kind].get(slug);
    const rows = await rest(`${kind}?slug=eq.${encodeURIComponent(slug)}&select=id`);
    const id = rows[0]?.id ?? null;
    if (id) idmap[kind].set(slug, id);
    return id;
  }

  async function apply(op) {
    const row = { ...op.row };
    if (row._event_slug !== undefined) {
      row.event_id = await resolve('events', row._event_slug);
      delete row._event_slug;
      if (!row.event_id) return;   // its event was deleted; the cascade got it
    }
    if (row._member_slug !== undefined) {
      row.member_id = await resolve('members', row._member_slug);
      delete row._member_slug;
    }
    if (row._ref_slug !== undefined) {
      // A linked event that this client cannot resolve (deleted, or never seen)
      // lands as null — the same state the on-delete-set-null FK would produce.
      row.event_ref = await resolve('events', row._ref_slug);
      delete row._ref_slug;
    }
    if (row._board_slug !== undefined) {
      row.board_id = await resolve('boards', row._board_slug);
      delete row._board_slug;
      if (!row.board_id) return;   // its board was deleted; the cascade got it
    }
    if (row._anchor_slug !== undefined) {
      row.anchor_event_id = await resolve('events', row._anchor_slug);
      delete row._anchor_slug;
      // tasks_one_dating: a fixed date and an anchor cannot coexist.
      if (row.anchor_event_id) row.due_on = null; else row.lead_days = null;
    }

    if (op.op === 'delete') {
      await rest(`${op.table}?${op.by}`, { method: 'DELETE' });
      return;
    }
    if (op.op === 'update') {
      await rest(`${op.table}?${op.by}`, { method: 'PATCH', body: JSON.stringify(row) });
      return;
    }
    await rest(`${op.table}?on_conflict=${op.on}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    // A newly inserted event has a uuid this client has not seen. Drop the
    // cached miss so the next role or task that references it resolves.
    if (op.table === 'events') idmap.events.delete(row.slug);
    // Same for a newly inserted board: the notes and links that follow in the
    // same flush resolve their _board_slug against it.
    if (op.table === 'boards') idmap.boards.delete(row.slug);
  }

  // --- Outbox ---------------------------------------------------------------
  // An edit made with no signal is still an edit. It is applied locally and
  // held here until a write succeeds, so the phone at the Rec is not a
  // read-only device.
  const readOutbox = () => {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
  };
  const writeOutbox = (ops) => {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(ops)); } catch { /* full */ }
    setStatus({ pending: ops.length });
  };

  async function drainOutbox() {
    if (!enabled() || !session) return;
    let ops = readOutbox();
    while (ops.length) {
      try {
        await apply(ops[0]);
      } catch (err) {
        // A write that will never succeed — a deleted parent, a rejected
        // enum — must not wedge the queue behind it forever. Postgres says
        // which by returning 4xx; anything else is treated as the network.
        const fatal = /^4\d\d /.test(String(err.message));
        if (!fatal) { setStatus({ mode: 'offline', error: String(err.message) }); return; }
        // Dropping it silently is how a delete looks like it "did not persist":
        // gone locally, still in the database, back on the next pull. Say so.
        setStatus({ error: `A change was rejected by the database (${ops[0].table} ${ops[0].op}) — reload to see the current state.` });
      }
      ops = ops.slice(1);
      writeOutbox(ops);
    }
    setStatus({ pending: 0 });
  }

  async function push(before, after) {
    if (!enabled()) return;
    const ops = diff(before, after);
    if (!ops.length) return;
    if (!session) {
      // Not signed in: the edit lives locally and is offered again on sign-in.
      writeOutbox([...readOutbox(), ...ops]);
      setStatus({ error: 'Sign in to share this change' });
      return;
    }
    writeOutbox([...readOutbox(), ...ops]);
    await drainOutbox();
  }

  // --- Storage --------------------------------------------------------------
  // Kit photos go to a public Storage bucket ('kit-photos'), so the whole
  // station sees the same picture. Uploading needs a session; the RLS on
  // storage.objects mirrors the tables. The returned public URL is what gets
  // stored on the kit row and rides sync like any other field.
  async function uploadKitPhoto(file, slug) {
    if (!enabled()) throw new Error('no project configured');
    if (!session) throw new Error('sign in first');
    const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${slug}-${Date.now()}.${ext || 'jpg'}`;
    const res = await fetch(`${CFG.url}/storage/v1/object/kit-photos/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: {
        apikey: CFG.key,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: file,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
    return `${CFG.url}/storage/v1/object/public/kit-photos/${encodeURIComponent(path)}`;
  }

  // --- Realtime -------------------------------------------------------------
  // Phoenix channels, spoken directly. Same reasoning as the REST client: the
  // protocol is four message shapes and vendoring a library to speak them
  // would cost more than writing them.
  function connect() {
    if (!enabled()) return;
    try { socket?.close(); } catch { /* not open */ }
    clearInterval(heartbeatTimer);

    const url = `${CFG.url.replace(/^http/, 'ws')}/realtime/v1/websocket`
      + `?apikey=${encodeURIComponent(CFG.key)}&vsn=1.0.0`;
    let ws;
    try { ws = new WebSocket(url); } catch { startPolling(); return; }
    socket = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        topic: 'realtime:public', event: 'phx_join', ref: '1',
        payload: {
          config: {
            broadcast: { self: false },
            postgres_changes: [
              { event: '*', schema: 'public', table: 'events' },
              { event: '*', schema: 'public', table: 'event_roles' },
              { event: '*', schema: 'public', table: 'tasks' },
              { event: '*', schema: 'public', table: 'members' },
            ],
          },
          // RLS is evaluated against this, not against the apikey.
          access_token: session?.access_token ?? CFG.key,
        },
      }));
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(Date.now()) }));
        }
      }, 30000);
      setStatus({ live: true });
      stopPolling();
      pull();
    };

    ws.onmessage = (msg) => {
      let m;
      try { m = JSON.parse(msg.data); } catch { return; }
      if (m.event === 'postgres_changes') schedulePull();
    };

    const down = () => {
      clearInterval(heartbeatTimer);
      setStatus({ live: false });
      // Realtime is the fast path, not the only path. Losing it drops to a
      // poll rather than to stale crew lists, and retries in the background.
      startPolling();
      if (socket === ws) setTimeout(connect, 5000);
    };
    ws.onclose = down;
    ws.onerror = down;
  }

  // Changes arrive one row at a time; a single drag writes an event and can
  // touch several roles. Coalesce so one gesture is one pull.
  let pullDebounce = null;
  function schedulePull() {
    clearTimeout(pullDebounce);
    pullDebounce = setTimeout(pull, 250);
  }

  function startPolling() {
    if (pollTimer || !enabled()) return;
    pollTimer = setInterval(pull, POLL_MS);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // --- Boot -----------------------------------------------------------------
  async function init(h) {
    hooks = h;
    if (!enabled()) { setStatus({ mode: 'local' }); return; }
    loadSession();
    const recovery = adoptUrlSession();   // a reset link overrides any saved session
    setStatus({ signedIn: Boolean(session), user: session?.user?.email ?? null,
      pending: readOutbox().length, recovery });
    scheduleRefresh();
    if (session && session.expires_at < Date.now()) await refresh();
    await pull();
    if (session) await loadAccess();
    if (status.mode === 'synced') {
      idmap = { events: new Map(), members: new Map(), boards: new Map() };
      await drainOutbox();
    }
    connect();

    // Coming back to a backgrounded tab is the commonest way to be looking at
    // a stale year, and it costs one request to not be.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pull();
    });
    window.addEventListener('online', () => { pull(); drainOutbox(); });
  }

  return {
    init, push, pull, signIn, signUp, signOut, recover, updatePassword, drainOutbox, uploadKitPhoto,
    loadAccess, listAccounts, createInvite, setGrant,
    enabled, status: () => status, session: () => session,
    // Exposed for scripts/e2e-sync.mjs, which drives the real database.
    _diff: diff, _toDocument: toDocument,
  };
})();
