#!/usr/bin/env node
// CTV OS — drive the prototype in real Chrome and assert the editing works.
//
//   node scripts/e2e.mjs
//
// Every check goes through the actual DOM the user touches. Nothing here calls
// an internal function directly, because the bugs live in the wiring.

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'prototype/ctv-os.html')).href;

// The database host is made unresolvable, so this suite is genuinely offline.
//
// It used to be offline by accident: the project had no tables, so every
// request failed and the page fell back to the seed. The moment the schema was
// pushed, three checks broke — a remote pull replaced the document mid-suite
// and the edits under test vanished. They were right to break. What they had
// been proving was "the database happens to be empty", and the claim this file
// is for is that the page is a complete, working tool with no network at all.
//
// The online claims are tested separately, against the real project, by
// scripts/e2e_sync.mjs.
const dbHost = (() => {
  const m = readFileSync(join(root, 'prototype/ctv-os.html'), 'utf8')
    .match(/const CFG = (\{.*?\}|null);/);
  if (!m || m[1] === 'null') return null;
  try { return new URL(JSON.parse(m[1]).url).host; } catch { return null; }
})();
const dbBlock = dbHost ? [`--host-resolver-rules=MAP ${dbHost} ~NOTFOUND`] : [];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--allow-file-access-from-files', ...dbBlock],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// Everything below runs against a file:// URL with no reachable database, which
// is the mode the product has to be strongest in: a phone at a venue, or a
// laptop before anyone has run the seed. Every edit here is made offline, held
// in localStorage, and would be sent on the next successful write.
//
// Chrome logs each failed request to the database itself, from outside the
// page, so it cannot be silenced in JavaScript. Those are separated out rather
// than counted as page errors — see the same reasoning in verify_deploy.mjs,
// which asserts the fallback that produces them.
const errors = [];
const offlineNoise = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // Matched on text as well as location: a failed fetch is reported against
  // the request URL, a failed WebSocket against the script that opened it.
  const where = m.location()?.url ?? '';
  const text = m.text();
  if (dbHost && (where.includes(dbHost) || text.includes(dbHost))) offlineNoise.push(where || text);
  else errors.push(text);
});

await page.goto(url, { waitUntil: 'networkidle0' });

// Nobody is assigned to events by default now, and the crew-gap signal — the
// open-role counts on the nav, the red badges, the Missing Requirements panels —
// is off by default, behind a setting. This suite is largely about that signal,
// so it turns it on once at the start (the preference persists in localStorage,
// so it survives the reloads later checks perform).
await page.evaluate(() => document.querySelector('[data-pref=flagCrew]').click());

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    pass++;
    console.log(`  ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};

// Read the store the way the app persists it, so the assertions are about
// what survives a reload rather than about in-memory variables.
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('ctvos.year.v2')));
const eventById = async (id) => (await stored()).events.find((e) => e.id === id);

// The open-role count rides the Calendar nav item, so it is legible from every
// screen. Reading it here also proves the sidebar re-renders on a mutation.
const openRoles = () =>
  page.$eval('[data-view="calendar"] .nav-pill', (el) => el.textContent.trim());

// Each section of the app is a view now, so a test has to be on the right one
// before its DOM exists at all.
const goto = (v) => page.evaluate((x) =>
  document.querySelector(`[data-view="${x}"]`).click(), v);

// The sheet slides in over 220ms. `.is-open` appears at the start of that, so
// a click fired on the class alone lands on a control that is still off-screen
// and Chrome reports it as unclickable. Wait for it to actually arrive.
const sheetSettled = () => page.waitForFunction(() => {
  const el = document.getElementById('sheet');
  return el.classList.contains('is-open')
    && el.getBoundingClientRect().right <= window.innerWidth + 1;
});

// And the same on the way out. Removing `.is-open` starts the slide; for the
// next 220ms the sheet still covers the right third of the screen and eats
// clicks aimed at what is underneath. Geometry is the truth here, not the class.
const sheetGone = () => page.waitForFunction(() => {
  const el = document.getElementById('sheet');
  return !el.classList.contains('is-open')
    && el.getBoundingClientRect().left >= window.innerWidth - 1;
});

// The drawer slides too. Same lesson as the sheet: wait for where it is, not
// for what class it has, or the next click races the transition.
const sideAt = (open) => page.waitForFunction((wantOpen) => {
  const el = document.getElementById('side');
  const left = Math.round(el.getBoundingClientRect().left);
  return wantOpen ? left === 0 : left <= -el.offsetWidth + 1;
}, { timeout: 5000 }, open);

// Jump the month grid to a given month. Tests that touch a specific day cell
// must do this rather than inherit whatever month a previous check left behind.
const gotoMonth = (y, m) => page.evaluate((yy, mm) =>
  document.querySelector(`.rib[data-y="${yy}"][data-m="${mm}"]`)?.click(), y, m);

// Navigate to the event's own month first — a badge that is not in the rendered
// month has no DOM node, and a test that assumes otherwise fails for a reason
// that has nothing to do with the behaviour under test.
const openSheet = async (id) => {
  const ev = await eventById(id);
  const [y, m] = ev.date.split('-').map(Number);
  await goto('calendar');
  await gotoMonth(y, m - 1);
  await page.evaluate((i) => document.querySelector(`.ev[data-ev="${i}"]`)?.click(), id);
  await page.waitForSelector('#sheet.is-open [data-f="date"]', { visible: true });
  await sheetSettled();
};

// Deleting an event now asks first: the button opens a confirm toast whose
// action reads "Delete". This confirms it.
const confirmDelete = async () => {
  await page.click('#sheet-del');
  await page.waitForFunction(() => {
    const b = document.getElementById('toast-undo');
    return !document.getElementById('toast').hidden && b.textContent.trim() === 'Delete';
  });
  await page.click('#toast-undo');
};

const closeAndTodo = async () => {
  await page.evaluate(() => document.getElementById('sheet-x')?.click());
  await goto('tasks');
  // List is the default layout now; the board-shaped assertions below need the
  // board, so switch to it explicitly.
  await page.click('[data-task-mode="board"]');
};

console.log('\n  MOVING EVENTS\n  ' + '-'.repeat(70));

await check('the date field moves an event', async () => {
  await goto('calendar');
  await openSheet('rugby-rec');
  await page.$eval('[data-f="date"]', (el) => {
    el.value = '2026-10-17';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.date, '2026-10-17', 'date');
  return '10 Oct → 17 Oct';
});

await check('moving an event marks the date confirmed', async () => {
  const ev = await eventById('rugby-rec');
  eq(ev.confidence, 'fixed', 'confidence');
  return 'estimated → fixed';
});

await check('prep due dates follow the event', async () => {
  // T−14 from 17 Oct is 3 Oct. This is the lead-time engine proving itself
  // through the interface, not through SQL.
  const due = await page.$$eval('.row-date', (els) => els.map((e) => e.textContent.trim()));
  if (!due.includes('03 OCT')) throw new Error(`no 03 OCT in ${JSON.stringify(due)}`);
  return `T−14 → ${due[0]}`;
});

await check('undo puts the event back', async () => {
  await page.click('#toast-undo');
  const ev = await eventById('rugby-rec');
  eq(ev.date, '2026-10-10', 'date');
  eq(ev.confidence, 'estimated', 'confidence');
  return 'date and confidence both restored';
});

await check('dragging an event badge onto another day moves it', async () => {
  await page.evaluate(() => {
    const chip = document.querySelector('.ev[data-ev="rugby-rec"]');
    const target = document.querySelector('.day[data-day="2026-10-24"]');
    const dt = new DataTransfer();
    chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.date, '2026-10-24', 'date');
  return 'dropped on 24 Oct';
});

await check('the badge renders on its new day', async () => {
  const where = await page.$eval('.ev[data-ev="rugby-rec"]',
    (el) => el.closest('.day').dataset.day);
  eq(where, '2026-10-24', 'day cell');
  await page.click('#toast-undo');
  return 'grid re-rendered in place';
});

console.log('\n  EDITING\n  ' + '-'.repeat(70));

await check('the title can be changed', async () => {
  await openSheet('rugby-rec');
  await page.$eval('[data-f="title"]', (el) => {
    el.value = 'Rugby at the Rec — Varsity fixture';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.title, 'Rugby at the Rec — Varsity fixture', 'title');
  await page.click('#toast-undo');
  // Assert the undo, not just the edit. The first version of this check
  // returned "and undone" without testing it, and passed while Undo was
  // unclickable underneath the scrim.
  eq((await eventById('rugby-rec')).title, 'Rugby at the Rec', 'title after undo');
  return 'changed, then undone';
});

await check('times can be set and cleared', async () => {
  await openSheet('rugby-rec');
  await page.$eval('[data-f="doors_time"]', (el) => {
    el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.doors_time, null, 'doors_time');
  await page.click('#toast-undo');
  return 'an empty field stores null, not ""';
});

await check('assigning crew closes an open role', async () => {
  // Nobody is assigned by default, so the count is relative: filling one role
  // drops the open count by exactly one, whatever it started at.
  const before = Number(await openRoles());
  await openSheet('rugby-rec');
  // GANTRY is index 1 on this event and starts open.
  await page.$eval('[data-role="1"]', (el) => {
    el.value = 'nina'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.roles[1].member, 'nina', 'gantry');
  const after = Number(await openRoles());
  eq(after, before - 1, 'sidebar count fell by one');
  return `${before} → ${after}`;
});

await check('the calendar badge updates with it', async () => {
  // The badge is one line of colour, so its coverage lives in the accessible
  // name. Asserting the title is asserting what a screen reader is told, not
  // just what the pixel looks like.
  const ev = await eventById('rugby-rec');
  const total = ev.roles.length;
  const filled = ev.roles.filter((r) => r.member).length;
  const [title, open] = await page.$eval('.ev[data-ev="rugby-rec"]',
    (el) => [el.title, el.classList.contains('is-open')]);
  if (!title.includes(`${filled}/${total} crewed`)) throw new Error(`title was "${title}"`);
  eq(open, filled < total, 'still flagged open while gaps remain');
  await page.click('#toast-undo');
  return `badge reads ${filled}/${total} crewed`;
});

await check('reopening a role puts the gap back', async () => {
  // With nothing assigned by default, fill a role first so there is a gap to put
  // back. Filling drops the count by one; reopening restores it exactly.
  await openSheet('rugby-rec');
  const base = Number(await openRoles());
  await page.$eval('[data-role="0"]', (el) => {
    el.value = 'nina'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq((await eventById('rugby-rec')).roles[0].member, 'nina', 'producer filled');
  eq(Number(await openRoles()), base - 1, 'count fell');
  await page.$eval('[data-role="0"]', (el) => {
    el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq((await eventById('rugby-rec')).roles[0].member, null, 'producer reopened');
  eq(Number(await openRoles()), base, 'count rose back');
  return `PRODUCER filled then reopened, ${base - 1} → ${base}`;
});

await check('Assign on the schedule lands on the right role', async () => {
  // The signature interaction of the Stitch design: an uncovered role is named
  // in the Missing Requirements panel and closed from inside it. It has to open
  // the right event *and* focus the right select, or it is just a link.
  await goto('schedule');
  // Prove the sheet is really gone before clicking — not merely un-classed.
  // waitForSelector('#sheet.is-open') would otherwise pass on a sheet an earlier
  // check left open, and a click aimed at Assign lands on the sheet itself while
  // it is still sliding out.
  await sheetGone();
  const target = await page.$eval('[data-assign]', (el) => el.dataset.assign);
  const [evId, roleIndex] = target.split(':');
  await page.$eval('[data-assign]', (el) => el.scrollIntoView({ block: 'center' }));
  await page.click('[data-assign]');
  await page.waitForSelector('#sheet.is-open');
  await sheetSettled();
  const landed = await page.evaluate(() => ({
    focused: document.activeElement?.dataset?.role,
    label: document.activeElement?.closest('.bay')?.querySelector('.bay-k')?.textContent,
    openBay: document.activeElement?.closest('.bay')?.classList.contains('is-open'),
  }));
  eq(landed.focused, roleIndex, 'focused role index');
  eq(landed.openBay, true, 'the bay it landed on is the open one');
  const title = await page.$eval('#sheet-in h2', (el) => el.textContent.trim());
  const ev = await eventById(evId);
  eq(title, ev.title, 'event opened');
  await page.evaluate(() => document.getElementById('sheet-x').click());
  return `${ev.title} → ${landed.label.trim()} focused`;
});

await check('every month of the year is whole weeks of equal days', async () => {
  // Two separate bugs lived here. `repeat(7, 1fr)` floors at min-content, and
  // because the badges are `white-space: nowrap` a single long title dragged its
  // column wider than the other six. And dropping the trailing week day-by-day
  // instead of week-by-week left the grid's own background showing through the
  // cells that were never emitted. Walk the whole academic year, not one month.
  await goto('calendar');
  await sheetGone();
  const months = await page.evaluate(() => {
    const res = [];
    const n = document.querySelectorAll('.rib').length;
    for (let i = 0; i < n; i++) {
      document.querySelectorAll('.rib')[i].click();   // render replaces the DOM
      const days = [...document.querySelectorAll('.day[data-day]')];
      const widths = [...new Set(days.map((d) => Math.round(d.getBoundingClientRect().width)))];
      let rowsOk = true;
      for (let r = 0; r < days.length / 7; r++) {
        const a = new Date(days[r * 7].dataset.day + 'T00:00');
        const z = new Date(days[r * 7 + 6].dataset.day + 'T00:00');
        if (a.getDay() !== 1 || z.getDay() !== 0) rowsOk = false;   // Monday-first
      }
      res.push({
        title: document.getElementById('month-title').textContent,
        cells: days.length, widths, rowsOk,
      });
    }
    return res;
  });
  eq(months.length, 11, 'months in the ribbon');
  for (const m of months) {
    if (m.cells % 7 !== 0) throw new Error(`${m.title}: ${m.cells} cells is not whole weeks`);
    if (!m.rowsOk) throw new Error(`${m.title}: a row does not run Monday to Sunday`);
    if (m.widths.length !== 1) throw new Error(`${m.title}: columns differ — ${m.widths.join('/')}px`);
  }
  const rows = months.map((m) => m.cells / 7);
  return `Aug→Jun, ${Math.min(...rows)}–${Math.max(...rows)} rows, all columns ${months[0].widths[0]}px`;
});

await check('today is a filled badge, and a day can be selected then cleared', async () => {
  // The station manager asked for a clearer "today" than the old light grey, and
  // for the day you tap to focus to be visible. Today is a filled green badge —
  // read by shape and colour, not shade alone — and a tap rings exactly one day.
  await goto('calendar');
  await sheetGone();
  // The month test above left the ribbon on the last month; return to today's.
  await page.evaluate(() => document.getElementById('today').click());
  const r = await page.evaluate(() => {
    const TODAY = '2026-08-07';
    const todayCell = document.querySelector(`.day[data-day="${TODAY}"]`);
    const hasToday = !!todayCell && todayCell.classList.contains('is-today');
    const badge = todayCell?.querySelector('.daynum');
    const bg = badge && getComputedStyle(badge).backgroundColor;
    // Select a different August day; the ring must land only on it.
    const other = [...document.querySelectorAll('.day[data-day]')]
      .find((d) => d.dataset.day !== TODAY && d.dataset.day.startsWith('2026-08'));
    const selKey = other.dataset.day;
    other.click();   // renderCalendar replaces the DOM
    const selected = [...document.querySelectorAll('.day.is-selected')].map((d) => d.dataset.day);
    // Tapping the selected day again clears it.
    document.querySelector(`.day[data-day="${selKey}"]`).click();
    const afterClear = document.querySelectorAll('.day.is-selected').length;
    return { hasToday, bg, selected, selKey, afterClear };
  });
  if (!r.hasToday) throw new Error('today cell is not marked is-today');
  if (!/rgb\(0,\s*68,\s*33\)/.test(r.bg || '')) throw new Error(`today badge is not the primary fill — got ${r.bg}`);
  eq(r.selected, [r.selKey], 'exactly the tapped day is ringed');
  if (r.afterClear !== 0) throw new Error('tapping the selected day again did not clear the ring');
  return 'today is a green badge; one tap rings a day, a second clears it';
});

console.log('\n  SEARCH\n  ' + '-'.repeat(70));

// Type into the real search box and wait past the 120ms debounce.
const typeSearch = (text) => page.evaluate(async (t) => {
  const input = document.getElementById('q');
  input.focus();
  input.value = t;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 220));
}, text);

await check('search reaches beyond events into crew and kit', async () => {
  // The complaint: from the calendar the box only touched calendar events. It
  // now opens a dropdown of matches from every module, so a name or a piece of
  // gear is found without first navigating to its page.
  await goto('calendar');
  await sheetGone();
  await typeSearch('sony');
  const kit = await page.evaluate(() => {
    const box = document.getElementById('search-results');
    return {
      open: !box.hidden,
      groups: [...box.querySelectorAll('.sr-group')].map((g) => g.textContent),
      titles: [...box.querySelectorAll('.sr-row .sr-title')].map((t) => t.textContent),
    };
  });
  if (!kit.open) throw new Error('the results dropdown did not open');
  if (!kit.groups.includes('Kit')) throw new Error(`no Kit group for "sony" — got ${kit.groups.join(', ')}`);
  if (!kit.titles.some((t) => /FX3/i.test(t))) throw new Error('the FX3 did not surface for "sony"');

  await typeSearch('will');
  const crew = await page.evaluate(() =>
    [...document.querySelectorAll('#search-results .sr-group')].map((g) => g.textContent));
  if (!crew.includes('Crew')) throw new Error(`no Crew group for "will" — got ${crew.join(', ')}`);
  return `"sony" → Kit (FX3), "will" → Crew, all from the calendar`;
});

await check('a search result jumps to the thing and opens it', async () => {
  await goto('calendar');
  await sheetGone();
  await typeSearch('sony');
  await page.evaluate(() =>
    document.querySelector('#search-results .sr-row[data-goto="kit"]').click());
  await page.evaluate(() => new Promise((r) => setTimeout(r, 260)));  // sheet slides in
  const landed = await page.evaluate(() => ({
    onKit: !document.getElementById('v-kit').hidden,
    sheetOpen: document.getElementById('sheet').classList.contains('is-open'),
    dropdownClosed: document.getElementById('search-results').hidden,
    sheetText: document.getElementById('sheet-in').textContent.includes('FX3'),
  }));
  if (!landed.onKit) throw new Error('clicking a kit result did not switch to the Kit view');
  if (!landed.sheetOpen || !landed.sheetText) throw new Error('the kit detail drawer did not open on the result');
  if (!landed.dropdownClosed) throw new Error('the results dropdown stayed open after a pick');
  // Leave the box empty so later suites are not filtering on a stale query.
  await page.evaluate(() => {
    const i = document.getElementById('q');
    i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 160)));
  return 'picked the FX3 → Kit view, drawer open, dropdown closed';
});

console.log('\n  CREWING\n  ' + '-'.repeat(70));

await check('the assign list separates free, busy and unqualified', async () => {
  // The product exists to prevent crew gaps, so the control that fills one must
  // not silently create a clash or put somebody on kit they are not signed off
  // on. Arena Night 1 has a VISION MIX role; only three of seven are trained.
  await openSheet('arena-1');
  const groups = await page.$$eval('.bay select', (sels) => {
    const bay = sels.find((s) => /vision/i.test(s.closest('.bay').querySelector('.bay-k').value));
    return [...bay.querySelectorAll('optgroup')].map((g) => ({
      label: g.label, names: [...g.querySelectorAll('option')].map((o) => o.textContent.trim()),
    }));
  });
  const untrained = groups.find((g) => /not signed off/i.test(g.label));
  if (!untrained) throw new Error(`no "not signed off" group — got ${groups.map((g) => g.label).join(' | ')}`);
  // Sam, Nina, Ela and Theo are not signed off on vision mix.
  for (const who of ['Sam', 'Nina', 'Theo']) {
    if (!untrained.names.some((n) => n.startsWith(who))) {
      throw new Error(`${who} is not signed off on vision mix but is not in that group`);
    }
  }
  const free = groups.find((g) => /free/i.test(g.label));
  if (!free || !free.names.length) throw new Error('nobody offered as free and signed off');
  return groups.map((g) => `${g.label}: ${g.names.length}`).join(' · ');
});

await check('somebody already booked that hour is flagged, not hidden', async () => {
  // Hiding them would be wrong: you may still want to double-book deliberately.
  // The list has to say so, and keep the choice available.
  const busy = await page.$$eval('.bay select optgroup', (gs) => {
    const g = gs.find((x) => /already on something else/i.test(x.label));
    return g ? [...g.querySelectorAll('option')].map((o) => o.textContent.trim()) : null;
  });
  if (busy && busy.length && !busy.every((n) => n.includes('—'))) {
    throw new Error(`a busy option does not name what they are on: ${busy.join(' | ')}`);
  }
  return busy?.length ? `${busy.length} flagged: ${busy[0]}` : 'nobody double-bookable on this event';
});

await check('a role can be added, named and crewed', async () => {
  // Before this existed a hand-made event was a dead end — the sheet told you
  // its roles had to be named and gave you no way to name them.
  const before = (await eventById('arena-1')).roles.length;
  await page.click('#role-add');
  await sheetSettled();
  eq((await eventById('arena-1')).roles.length, before + 1, 'roles after add');

  await page.$eval(`[data-role-label="${before}"]`, (el) => {
    el.value = 'back cam'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const added = (await eventById('arena-1')).roles[before];
  eq(added.label, 'BACK CAM', 'label, upper-cased');
  // The skill the label implies is inferred, so the new role filters crew too.
  eq(added.role, 'camera', 'inferred skill');

  await page.$eval(`[data-role="${before}"]`, (el) => {
    el.value = 'nina'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq((await eventById('arena-1')).roles[before].member, 'nina', 'assigned');
  return 'added → named BACK CAM → inferred camera → crewed';
});

await check('role times and on-site are editable and drive clashes', async () => {
  const i = (await eventById('arena-1')).roles.length - 1;
  await page.click(`[data-role-edit="${i}"]`);
  await sheetSettled();
  await page.$eval(`[data-role-time="${i}:from"]`, (el) => {
    el.value = '20:00'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq((await eventById('arena-1')).roles[i].from, '20:00', 'from');
  // The disclosure survives the re-render an edit triggers, so the bay is still
  // open here — clicking the toggle again would close it.
  await page.$eval(`[data-role-onsite="${i}"]`, (el) => {
    el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq((await eventById('arena-1')).roles[i].on_site, false, 'on_site');
  return 'times set, then moved off site';
});

await check('a role can be removed again', async () => {
  const roles = (await eventById('arena-1')).roles;
  const i = roles.length - 1;

  // Remove is deliberately quiet: it appears when the bay it belongs to is
  // hovered or focused, so a bank of six roles is not a bank of six delete
  // buttons. Hovering first is therefore part of the behaviour under test.
  await page.hover(`[data-role-del="${i}"]`);
  // Poll rather than sample: the fade is 160ms and a single read lands
  // mid-transition at whatever opacity the frame happened to be on.
  await page.waitForFunction((sel) =>
    getComputedStyle(document.querySelector(sel)).opacity === '1', {}, `[data-role-del="${i}"]`);

  // A real mouse at real coordinates, rather than page.click(selector).
  // Puppeteer 24's selector click re-queries through its locator pipeline and
  // loses an element that is mid-transition; pressing the actual pixel is both
  // closer to what the user does and immune to that.
  const clickAt = async (sel) => {
    const box = await page.$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
  };

  await clickAt(`[data-role-del="${i}"]`);
  await sheetSettled();
  eq((await eventById('arena-1')).roles.length, roles.length - 1, 'roles after remove');
  await page.click('#toast-undo');
  eq((await eventById('arena-1')).roles.length, roles.length, 'roles after undo');
  await page.hover(`[data-role-del="${i}"]`);
  await clickAt(`[data-role-del="${i}"]`);             // leave the seed as we found it
  await page.evaluate(() => document.getElementById('sheet-x').click());
  return 'hidden until hover, removed, undone, removed again';
});

await check('undo refreshes the sheet that is still open', async () => {
  // Undo lives on the toast, outside the sheet. Before the sheet became part of
  // render(), pressing it restored the data and left the sheet showing the
  // state you had just undone.
  await openSheet('arena-1');
  const original = await page.$eval('[data-f="title"]', (el) => el.value);
  await page.$eval('[data-f="title"]', (el) => {
    el.value = 'Arena Night 1 — renamed'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq(await page.$eval('[data-f="title"]', (el) => el.value), 'Arena Night 1 — renamed', 'field after edit');
  await page.click('#toast-undo');
  eq(await page.$eval('[data-f="title"]', (el) => el.value), original, 'field after undo');
  eq((await eventById('arena-1')).title, original, 'stored title after undo');
  await page.evaluate(() => document.getElementById('sheet-x').click());
  return 'the field on screen follows the store, not the other way round';
});

await check('deleting the event the sheet is showing closes it', async () => {
  await openSheet('arena-4');
  await confirmDelete();
  await sheetGone();
  eq(await page.$eval('#sheet', (el) => el.classList.contains('is-open')), false, 'sheet open');
  await page.click('#toast-undo');
  // Undo brings the event back but must not re-open a sheet you already left.
  eq(await page.$eval('#sheet', (el) => el.classList.contains('is-open')), false, 'sheet re-opened');
  eq(!!(await eventById('arena-4')), true, 'event restored');
  return 'closed on delete, stayed closed on undo';
});

console.log('\n  ADDING AND DELETING\n  ' + '-'.repeat(70));

await check('a day can take a new event', async () => {
  await goto('calendar');
  await sheetGone();
  await gotoMonth(2026, 9);                      // October
  await page.evaluate(() => document.querySelector('.day[data-day="2026-10-15"] .day-add').click());
  await page.waitForSelector('#sheet.is-open [data-f="title"]');
  await sheetSettled();
  const evs = (await stored()).events.filter((e) => e.date === '2026-10-15');
  eq(evs.length, 1, 'events on 15 Oct');
  eq(evs[0].title, 'New event', 'title');
  return 'created and its sheet opened';
});

await check('a new event starts with no crew, not with no gap', async () => {
  // An event with zero roles must not borrow the crewed colour. 0/0 satisfies
  // "no open roles" arithmetically, so without a third state a brand-new event
  // renders exactly like a finished one — a fabricated complete state, which is
  // worse than an honest empty one.
  const id = (await stored()).events.find((e) => e.date === '2026-10-15').id;
  await page.evaluate(() => document.getElementById('sheet-x').click());
  const badge = await page.$eval(`.ev[data-ev="${id}"]`, (el) => ({
    bare: el.classList.contains('is-bare'), title: el.title,
  }));
  eq(badge.bare, true, 'neutral, not crewed');
  if (!/no roles yet/.test(badge.title)) throw new Error(`title was "${badge.title}"`);
  // And it says so on the schedule too, in words.
  await goto('schedule');
  const said = await page.$$eval('.tl-card', (els) =>
    els.some((e) => /no roles yet/.test(e.textContent)));
  eq(said, true, 'schedule states it in words');
  await goto('calendar');
  await gotoMonth(2026, 9);
  await page.evaluate((i) => document.querySelector(`.ev[data-ev="${i}"]`).click(), id);
  await page.waitForSelector('#sheet.is-open');
  await sheetSettled();
  return 'neutral badge, "no roles yet" on both screens';
});

await check('deleting asks first, and Cancel keeps the event', async () => {
  const id = (await stored()).events.find((e) => e.date === '2026-10-15').id;
  await page.click('#sheet-del');
  await page.waitForFunction(() => !document.getElementById('toast-cancel').hidden);
  await page.click('#toast-cancel');
  eq((await stored()).events.some((e) => e.id === id), true, 'event survived the cancel');
  return 'the confirm toast can be backed out of';
});

await check('deleting removes the event', async () => {
  const id = (await stored()).events.find((e) => e.date === '2026-10-15').id;
  await confirmDelete();
  const gone = (await stored()).events.some((e) => e.id === id);
  eq(gone, false, 'still present');
  return 'and the sheet closed';
});

await check('undo restores a deleted event', async () => {
  await page.click('#toast-undo');
  const evs = (await stored()).events.filter((e) => e.date === '2026-10-15');
  eq(evs.length, 1, 'events on 15 Oct');
  await gotoMonth(2026, 9);
  await page.click(`.ev[data-ev="${evs[0].id}"]`);
  await page.waitForSelector('#sheet.is-open');
  await sheetSettled();
  await confirmDelete();
  return 'restored, then cleaned up';
});

console.log('\n  PERSISTENCE\n  ' + '-'.repeat(70));

await check('edits survive a reload', async () => {
  await openSheet('ntd');
  await page.$eval('[data-f="venue"]', (el) => {
    el.value = 'Studio'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.reload({ waitUntil: 'networkidle0' });
  const ev = await eventById('ntd');
  eq(ev.venue, 'Studio', 'venue');
  return 'National Television Day kept its venue';
});

await check('reset restores the seed year', async () => {
  await page.click('#reset');
  const ev = await eventById('ntd');
  eq(ev.venue, undefined, 'venue');
  const n = (await stored()).events.length;
  eq(n, 31, 'event count');
  return `${n} events back`;
});

await check('reset is undoable too', async () => {
  await page.click('#toast-undo');
  const ev = await eventById('ntd');
  eq(ev.venue, 'Studio', 'venue');
  return 'the edit came back';
});

await check('export produces the corrected year', async () => {
  const json = await page.evaluate(() => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('export').click();
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;
    return captured.text();
  });
  const parsed = JSON.parse(json);
  eq(parsed.events.length, 31, 'events');
  eq(parsed.events.find((e) => e.id === 'ntd').venue, 'Studio', 'edited venue');
  if (!parsed.societies || !parsed.prep_templates) throw new Error('lost the reference data');
  return 'valid year.json with the edits in it';
});

console.log('\n  EVENT KIT + COPY\n  ' + '-'.repeat(70));

await check('kit can be added to and removed from an event', async () => {
  await goto('calendar');
  await sheetGone();
  await openSheet('ntd');
  const before = (await eventById('ntd')).kit_needed?.length ?? 0;
  await page.$eval('[data-kitneed-add]', (el) => {
    el.value = el.querySelector('option[value]:not([value=""])').value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  eq((await eventById('ntd')).kit_needed.length, before + 1, 'kit added');
  await page.click('[data-kitneed-del="0"]');
  eq((await eventById('ntd')).kit_needed.length, before, 'kit removed');
  await page.evaluate(() => document.getElementById('sheet-x').click());
  return 'added then removed a kit item on NTD';
});

await check('an event copies to formatted text with its crew and kit', async () => {
  await openSheet('rugby-rec');
  const text = await page.evaluate(async () => {
    let captured = null;
    // navigator.clipboard is a read-only accessor, so replace it with defineProperty.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (t) => { captured = t; } },
    });
    document.getElementById('sheet-copy').click();
    await new Promise((r) => setTimeout(r, 60));
    return captured;
  });
  if (!text) throw new Error('nothing copied');
  for (const needle of ['Rugby', 'Crew', 'Kit needed']) {
    if (!text.includes(needle)) throw new Error(`copied text missing "${needle}"`);
  }
  await page.evaluate(() => document.getElementById('sheet-x').click());
  return `${text.split('\n').length} lines, crew and kit included`;
});

console.log('\n  CREW\n  ' + '-'.repeat(70));

await check('a crew member can be renamed and retrained', async () => {
  await goto('crew');
  await sheetGone();
  await page.click('[data-member-edit="nina"]');
  await page.$eval('[data-member-form="nina"] [name=committee_role]', (el) => { el.value = 'Head of Production'; });
  await page.$eval('[data-member-form="nina"] input[name=trained][value=audio]', (el) => { if (!el.checked) el.click(); });
  await page.click('[data-member-form="nina"] button[type=submit]');
  const m = (await stored()).members.find((x) => x.id === 'nina');
  eq(m.committee_role, 'Head of Production', 'committee role saved');
  if (!m.trained.includes('audio')) throw new Error('audio training not saved');
  return `nina → ${m.committee_role}, trained ${m.trained.join('/')}`;
});

await check('a crew member can be removed, and undo brings them back', async () => {
  // Crew is the register a new committee resets, so delete is real, not a
  // deactivate. It lives in the edit form and confirms first, like every delete.
  await goto('crew');
  await sheetGone();
  const before = (await stored()).members.length;
  await page.click('[data-member-edit="destin"]');
  await page.click('[data-member-delete="destin"]');
  await page.waitForFunction(() => {
    const b = document.getElementById('toast-undo');
    return !document.getElementById('toast').hidden && b.textContent.trim() === 'Delete';
  });
  await page.click('#toast-undo');   // confirm the delete
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.members || []).length === n - 1;
  }, {}, before);
  const gone = await stored();
  if (gone.members.some((m) => m.id === 'destin')) throw new Error('destin was not removed');
  // Removing a person must not leave a role pointing at a member who is gone —
  // the slot reopens instead.
  if (gone.events.some((e) => (e.roles || []).some((r) => r.member === 'destin')))
    throw new Error('a role still references the deleted member');
  await page.click('#toast-undo');   // undo restores the person
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.members || []).length === n;
  }, {}, before);
  if (!(await stored()).members.some((m) => m.id === 'destin'))
    throw new Error('undo did not restore destin');
  return `crew ${before} → ${before - 1} → ${before}, no dangling roles`;
});

await check('the crew page carries the handover job descriptions', async () => {
  await goto('crew');
  const roles = await page.$$eval('.role-def h3', (els) => els.map((e) => e.textContent.trim()));
  if (!roles.some((r) => /Station Manager/i.test(r))) throw new Error('no committee descriptions');
  if (!roles.some((r) => /Vision mixer/i.test(r))) throw new Error('no crew descriptions');
  return `${roles.length} role descriptions from the handover`;
});

console.log('\n  KIT\n  ' + '-'.repeat(70));

await check('a kit item opens and its usage notes save', async () => {
  await goto('kit');
  await sheetGone();
  await page.click('[data-kit="cam-fx3-1"]');
  await page.waitForSelector('#sheet.is-open');
  await page.$eval('[data-kf="usage"]', (el) => {
    el.value = 'Fit the cage, insert an SD card, format in-camera before the shoot.';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const k = (await stored()).kit.find((x) => x.id === 'cam-fx3-1');
  if (!/format in-camera/.test(k.usage || '')) throw new Error('usage not saved');
  await page.evaluate(() => document.getElementById('sheet-x').click());
  return 'usage note saved on the FX3';
});

await check('a kit item is written only on Save, not on Add', async () => {
  await goto('kit');
  await sheetGone();
  const before = (await stored()).kit.length;
  await page.click('#kit-add');
  await page.waitForSelector('#sheet.is-open #kit-save');
  await sheetSettled();
  // Opening the draft must NOT create a row — the whole point of the change.
  eq((await stored()).kit.length, before, 'no row created on Add');
  // A blank Save is refused, so an empty draft never becomes a row either.
  await page.click('#kit-save');
  eq((await stored()).kit.length, before, 'blank Save refused');
  // Name it, then Save — now, and only now, it lands.
  await page.type('[data-kf="name"]', 'Aputure 600d');
  await page.click('#kit-save');
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.kit || []).length === n + 1;
  }, {}, before);
  if (!(await stored()).kit.some((k) => k.name === 'Aputure 600d')) {
    throw new Error('the saved kit was not written');
  }
  await sheetGone();   // Save closes the drawer
  return `Add opened a draft; Save wrote it — ${before} → ${before + 1}`;
});

await check('a kit item can be deleted, and undo brings it back', async () => {
  await goto('kit');
  await sheetGone();
  const before = (await stored()).kit.length;
  await page.click('[data-kit="cam-a6400"]');
  await page.waitForSelector('#sheet.is-open #kit-del');
  await sheetSettled();
  await page.click('#kit-del');
  await page.waitForFunction(() => {
    const b = document.getElementById('toast-undo');
    return !document.getElementById('toast').hidden && b.textContent.trim() === 'Delete';
  });
  await page.click('#toast-undo');   // confirm the delete
  await sheetGone();                 // deleting closes the drawer
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.kit || []).length === n - 1;
  }, {}, before);
  if ((await stored()).kit.some((k) => k.id === 'cam-a6400')) throw new Error('the a6400 was not removed');
  await page.click('#toast-undo');   // undo restores the piece
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.kit || []).length === n;
  }, {}, before);
  if (!(await stored()).kit.some((k) => k.id === 'cam-a6400')) throw new Error('undo did not restore the a6400');
  return `kit ${before} → ${before - 1} → ${before}`;
});

await check('a prep step can be added to an event, and removed again', async () => {
  await openSheet('rugby-rec');
  const before = ((await eventById('rugby-rec')).prep || []).length;
  // Open the add form, fill it, submit.
  await page.click('#prep-add');
  await page.waitForSelector('#prep-form [name=label]', { visible: true });
  await page.type('#prep-form [name=label]', 'Confirm parking with the Rec');
  await page.$eval('#prep-form [name=lead]', (el) => { el.value = '5'; });
  await page.click('#prep-form button[type=submit]');
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.events.find((e) => e.id === 'rugby-rec').prep || []).length === n + 1;
  }, {}, before);
  const added = (await eventById('rugby-rec')).prep.at(-1);
  eq(added.label, 'Confirm parking with the Rec', 'label stored');
  eq(added.lead_days, 5, 'lead days stored');
  if (!added.id) throw new Error('added prep has no id to sync by');
  // The own-prep delete control is present; use it to remove what we added.
  const dels = await page.$$('[data-prep-del]');
  if (!dels.length) throw new Error('no delete control on the event-own prep');
  await dels.at(-1).click();
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.events.find((e) => e.id === 'rugby-rec').prep || []).length === n;
  }, {}, before);
  await page.evaluate(() => document.getElementById('sheet-x').click());
  await sheetGone();   // don't leave the sheet covering the next test's controls
  return `prep ${before} → ${before + 1} → ${before}, keyed for sync`;
});

await check('a template prep step can be dismissed for one event', async () => {
  await openSheet('rugby-rec');
  // Template lines carry a skip control (not a delete). Dismiss the first one.
  const skips = await page.$$('[data-prep-skip]');
  if (!skips.length) throw new Error('no template step to dismiss');
  const label = await page.evaluate((b) => b.dataset.prepSkip, skips[0]);
  await skips[0].click();
  await page.waitForFunction((lbl) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.events.find((e) => e.id === 'rugby-rec').prep_skip || []).includes(lbl);
  }, {}, label);
  // The dismissal is per-event, not a change to the shared template.
  const tmplUntouched = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ctvos.year.v2')).prep_templates.length);
  if (!tmplUntouched) throw new Error('templates were emptied');
  await page.click('#toast-undo');   // restore, keeping the seed state clean
  await page.waitForFunction((lbl) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return !(d.events.find((e) => e.id === 'rugby-rec').prep_skip || []).includes(lbl);
  }, {}, label);
  await page.evaluate(() => document.getElementById('sheet-x').click());
  await sheetGone();
  return `"${label}" hidden for this event, template intact, then undone`;
});

await check('a calendar event can be linked as a prep step', async () => {
  await openSheet('rugby-rec');
  const before = ((await eventById('rugby-rec')).prep || []).length;
  await page.click('#prep-add');
  await page.waitForSelector('#prep-form [name=ref]', { visible: true });
  // Pick the first real event in the link dropdown (index 0 is the free-text row).
  const ref = await page.$eval('#prep-form [name=ref] option:nth-child(2)', (o) => o.value);
  await page.select('#prep-form [name=ref]', ref);
  await page.click('#prep-form button[type=submit]');
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.events.find((e) => e.id === 'rugby-rec').prep || []).length === n + 1;
  }, {}, before);
  const added = (await eventById('rugby-rec')).prep.at(-1);
  eq(added.event_ref, ref, 'linked event slug stored');
  // The linked step renders as a jump into that event's sheet.
  const link = await page.$(`[data-prep-open="${ref}"]`);
  if (!link) throw new Error('no link control for the linked event');
  // Its due is the linked event's date, so clicking through opens that event.
  await link.click();
  await page.waitForSelector('#sheet.is-open [data-f="date"]', { visible: true });
  const openTitle = await page.$eval('#sheet-in h2', (h) => h.textContent.trim());
  const linkedEv = await eventById(ref);
  eq(openTitle, linkedEv.title, 'clicking the step opened the linked event');
  // Clean up: reopen rugby-rec and remove the linked step.
  await openSheet('rugby-rec');
  await page.$$eval('[data-prep-del]', (bs) => bs[bs.length - 1].click());
  await page.waitForFunction((n) => {
    const d = JSON.parse(localStorage.getItem('ctvos.year.v2'));
    return (d.events.find((e) => e.id === 'rugby-rec').prep || []).length === n;
  }, {}, before);
  await page.evaluate(() => document.getElementById('sheet-x').click());
  await sheetGone();
  return `linked ${linkedEv.title}, opened it, then removed the step`;
});

console.log('\n  TO DO\n  ' + '-'.repeat(70));

// List is the default layout; most checks below assert against the board, so
// this helper lands on To do and switches to it.
const gotoTodo = async () => { await goto('tasks'); await page.click('[data-task-mode="board"]'); };

await check('the to-do opens on the list view by default', async () => {
  await goto('tasks');
  const rows = await page.$$eval('#v-tasks .tbl tbody tr', (els) => els.length);
  const cards = await page.$$eval('#v-tasks .tcard', (els) => els.length);
  if (!rows) throw new Error('no list rows on the default view');
  eq(cards, 0, 'the board is not what opens');
  const pressed = await page.$eval('[data-task-mode="list"]', (el) => el.getAttribute('aria-pressed'));
  eq(pressed, 'true', 'the list toggle is the active one');
  return `${rows} rows, list is default`;
});

await check('the to-do list holds the whole handover', async () => {
  await gotoTodo();
  const n = (await stored()).tasks.length;
  const rows = await page.$$eval('.tcard', (els) => els.length);
  eq(rows, n, 'cards on the board');
  const sections = (await stored()).tasks.map((t) => t.source);
  // Every section of the handover that contains an instruction is represented.
  for (const s of ['Ia', 'Ib', 'Ic', 'IIIa', 'IVb', 'Va', 'VIa', 'VII', 'VIII']) {
    if (!sections.some((x) => x === s)) throw new Error(`nothing sourced from section ${s}`);
  }
  return `${n} tasks, sections Ia through VIII`;
});

await check('tasks are grouped by when they bite', async () => {
  // The lead-time buckets survived the redesign as the board's columns; the
  // grouping is the product, the kanban is only how it is drawn.
  const buckets = await page.$$eval('.col-h .t-label', (els) =>
    els.map((e) => e.textContent.trim()));
  if (!buckets.length) throw new Error('no columns rendered');
  const known = ['Overdue', 'Next 7 days', 'Next 30 days', 'Later', 'No date yet'];
  eq(buckets, known, 'columns, in order');
  return buckets.join(' · ');
});

await check('the list view shows the same tasks as the board', async () => {
  const n = await page.$$eval('.tcard', (els) => els.length);
  await page.click('[data-task-mode="list"]');
  // Scope to the tasks view: the Kit locker also renders a `.tbl`, and an
  // unscoped selector would count its rows too.
  const rows = await page.$$eval('#v-tasks .tbl tbody tr', (els) => els.length);
  eq(rows, n, 'rows in the table');
  await page.click('[data-task-mode="board"]');
  return `${rows} tasks either way`;
});

await check('an anchored task moves when its event moves', async () => {
  // "Order merch" is T−28 from Welcome Weekend night 1 (18 Sep) = 21 Aug.
  const dueOf = (id) => page.evaluate((i) => {
    const box = document.querySelector(`[data-task="${i}"]`);
    // "21 AUG · in 14d" — the date half is what the lead-time engine decides.
    return box.closest('.tcard').querySelector('.tcard-due')
      .textContent.split('·')[0].trim();
  }, id);
  eq(await dueOf('merch'), '21 AUG', 'merch due before the move');

  await openSheet('ww-fri');
  await page.$eval('[data-f="date"]', (el) => {
    el.value = '2026-09-25'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await closeAndTodo();
  eq(await dueOf('merch'), '28 AUG', 'merch due after the move');
  await page.click('#toast-undo');
  await gotoTodo();
  eq(await dueOf('merch'), '21 AUG', 'merch due after undo');
  return 'welcome weekend +7d → merch deadline +7d, and back';
});

await check('ticking a task persists and is undoable', async () => {
  await page.click('[data-task="outlook"]');
  eq((await stored()).tasks.find((t) => t.id === 'outlook').done, true, 'done');
  const count = await page.$eval('#v-tasks .page-head p', (el) => el.textContent.trim());
  if (!count.includes('1 of 56 done')) throw new Error(`progress read "${count}"`);
  await page.click('#toast-undo');
  eq((await stored()).tasks.find((t) => t.id === 'outlook').done, false, 'done after undo');
  return 'progress counted, then undone';
});

await check('completed to-dos move behind their own pill', async () => {
  await goto('tasks');
  await page.click('[data-task-mode="list"]');
  await page.click('[data-status="upcoming"]');
  // Tick a task; it must leave the upcoming list entirely, not just grey out.
  await page.click('#v-tasks [data-task="outlook"]');
  await page.waitForFunction(() => !document.querySelector('#v-tasks [data-task="outlook"]'));
  // The Completed pill holds it, and everything shown there is done.
  await page.click('[data-status="done"]');
  await page.waitForSelector('#v-tasks [data-task="outlook"]');
  const allDone = await page.$$eval('#v-tasks tbody tr', (rows) =>
    rows.length > 0 && rows.every((r) => r.querySelector('.box')?.checked));
  if (!allDone) throw new Error('the completed view is showing a not-done task');
  // Put it back and return to the upcoming view for the checks that follow.
  await page.click('#v-tasks [data-task="outlook"]');
  await page.click('[data-status="upcoming"]');
  eq((await stored()).tasks.find((t) => t.id === 'outlook').done, false, 'restored to not-done');
  return 'ticked → gone from upcoming → shown under Completed → restored';
});

await check('the area filter narrows the list', async () => {
  await gotoTodo();
  // The area pills collapsed into a sort/filter dropdown; drive that instead.
  await page.select('[data-area-select]', 'nasta');
  const areas = await page.$$eval('.tcard .tag', (els) =>
    [...new Set(els.map((e) => e.textContent.trim()))]);
  eq(areas, ['NaSTA'], 'areas shown');
  await page.select('[data-area-select]', 'all');
  return '8 NaSTA tasks, nothing else';
});

await check('exported year carries the tasks', async () => {
  await page.click('[data-task="successor"]');
  const json = await page.evaluate(() => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { captured = b; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('export').click();
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;
    return captured.text();
  });
  const parsed = JSON.parse(json);
  eq(parsed.tasks.length, 56, 'tasks');
  eq(parsed.tasks.find((t) => t.id === 'successor').done, true, 'tick survived export');
  return '56 tasks with their state';
});

await check('a to-do can be added, and it lands in the right bucket', async () => {
  // The list was read-only apart from ticking: 56 items from the handover and
  // no way to record the thing you just thought of.
  await gotoTodo();
  const before = (await stored()).tasks.length;
  await page.click('#task-new');
  await page.$eval('#task-form [name=title]', (el) => { el.value = 'Chase Helen about the risk assessment'; });
  await page.$eval('#task-form [name=area]', (el) => { el.value = 'setup'; });
  await page.$eval('#task-form [name=due]', (el) => { el.value = '2026-08-10'; });
  await page.click('#task-form button[type=submit]');
  const tasks = (await stored()).tasks;
  eq(tasks.length, before + 1, 'tasks after add');
  const mine = tasks[tasks.length - 1];
  eq(mine.title, 'Chase Helen about the risk assessment', 'title');
  eq(mine.source, 'you', 'marked as yours, not as a handover section');
  // 10 Aug is three days out from TODAY, so it belongs in Next 7 days.
  const col = await page.evaluate((id) => {
    const box = document.querySelector(`[data-task="${id}"]`);
    return box?.closest('.col')?.querySelector('.t-label')?.textContent.trim();
  }, mine.id);
  eq(col, 'Next 7 days', 'column');
  return `added → ${col}`;
});

await check('a to-do can be deleted, and that is undoable', async () => {
  const id = (await stored()).tasks.at(-1).id;
  const n = (await stored()).tasks.length;
  await page.hover(`[data-task-del="${id}"]`);
  await page.waitForFunction((sel) =>
    getComputedStyle(document.querySelector(sel)).opacity === '1', {}, `[data-task-del="${id}"]`);
  const box = await page.$eval(`[data-task-del="${id}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  eq((await stored()).tasks.length, n - 1, 'tasks after delete');
  await page.click('#toast-undo');
  eq((await stored()).tasks.length, n, 'tasks after undo');
  return 'deleted, then undone';
});

console.log('\n  BOARD\n  ' + '-'.repeat(70));

// The board is now part of the document: notes and links live in DATA.boards and
// go through mutate() like everything else, so they persist, undo and sync. The
// viewport (which board is open, and its pan/zoom) is a per-client preference and
// stays in its own localStorage key, out of the shared document.
const boardBox = () => page.$eval('.board-canvas',
  (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

await check('the board seeds a canvas and a new note persists to the document', async () => {
  await goto('board');
  const seed = (await stored()).boards;
  if (!seed.length) throw new Error('no seed board in the document');
  if (!seed[0].nodes.length) throw new Error('the seed board has no notes');
  const box = await boardBox();
  // Double-click an empty patch, clear of the seed notes and the zoom toolbar.
  await page.mouse.click(box.x + box.w * 0.2, box.y + box.h * 0.8, { clickCount: 2 });
  await page.waitForFunction(() => document.querySelector('.board-node.is-editing'));
  await page.keyboard.type('E2E idea');
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem('ctvos.year.v2')).boards[0].nodes.some((n) => n.body === 'E2E idea'));
  const note = (await stored()).boards[0].nodes.find((n) => n.body === 'E2E idea');
  if ('text' in note) throw new Error('the note kept the prototype-era text field instead of body');
  // It survives a reload — it is in the document, not a transient bit of the view.
  await page.reload({ waitUntil: 'load' });
  await goto('board');
  if (!(await stored()).boards[0].nodes.some((n) => n.body === 'E2E idea'))
    throw new Error('the note did not persist across a reload');
  return `seed ${seed[0].nodes.length} notes; added one, body-keyed, survives reload`;
});

await check('a note is undoable, like every other edit', async () => {
  await goto('board');
  const before = (await stored()).boards[0].nodes.length;
  const box = await boardBox();
  await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.8, { clickCount: 2 });
  await page.waitForFunction(() => document.querySelector('.board-node.is-editing'));
  await page.keyboard.type('scratch note');
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForFunction((n) =>
    JSON.parse(localStorage.getItem('ctvos.year.v2')).boards[0].nodes.length === n + 1, {}, before);
  await page.click('#toast-undo');   // undo the text, then undo the add
  await page.click('#toast-undo').catch(() => {});
  await page.waitForFunction((n) =>
    !JSON.parse(localStorage.getItem('ctvos.year.v2')).boards[0].nodes.some((x) => x.body === 'scratch note'),
    {}, before);
  return 'added a note, undo removed it';
});

await check('the board viewport is a per-client preference, not shared data', async () => {
  await goto('board');
  const doc = (await stored()).boards[0];
  if ('cam' in doc) throw new Error('a camera leaked into the shared document');
  if (doc.nodes.some((n) => 'text' in n)) throw new Error('a note leaked the prototype text field');
  const ui = JSON.parse(await page.evaluate(() => localStorage.getItem('ctvos.board.ui.v1')) || 'null');
  if (!ui || !ui.activeId) throw new Error('the per-client board UI store is missing or empty');
  return 'boards/notes in the document; camera + active board in ctvos.board.ui.v1';
});

console.log('\n  ACCOUNTS\n  ' + '-'.repeat(70));

await check('the account control opens a menu and the sign-in dialog', async () => {
  // Offline (this suite's world) the app stays fully usable and the account
  // button offers sign-in. The read-only gate and private-module hiding only
  // engage against the live database, which npm run e2e:sync exercises.
  await goto('calendar');
  await sheetGone();
  if (await page.$eval('#account', (el) => el.hidden)) throw new Error('account button hidden');
  await page.click('#account');
  const menu = await page.$eval('#acct-menu', (el) => (el.hidden ? '' : el.textContent));
  if (!/sign in/i.test(menu)) throw new Error('menu did not offer sign in');
  await page.click('#acct-signin');
  await page.waitForSelector('#auth:not([hidden])');
  const title = await page.$eval('#auth-h', (el) => el.textContent.trim());
  await page.evaluate(() => document.getElementById('auth-x').click());
  return `account menu → "${title}"`;
});

await check('offline stays editable — the field case, not read-only', async () => {
  // The read-only gate is for an anonymous visitor on the live site, never for a
  // phone with no signal: those edits queue. Prove editing still works here.
  await goto('calendar');
  await sheetGone();
  const readonly = await page.evaluate(() => document.body.classList.contains('is-readonly'));
  eq(readonly, false, 'not read-only while offline');
  return 'offline is a working state, not a locked one';
});

console.log('\n  PHONE\n  ' + '-'.repeat(70));

await check('the sidebar is reachable and dismissable on a phone', async () => {
  // The menu button was declared display:none *after* the media query that
  // shows it, so source order beat the query and there was no way to change
  // screens on a phone at all.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: 'networkidle0' });
  const menu = await page.$eval('#menu', (el) => {
    const r = el.getBoundingClientRect();
    return { shown: getComputedStyle(el).display !== 'none', w: Math.round(r.width), h: Math.round(r.height) };
  });
  eq(menu.shown, true, 'menu button rendered');
  if (menu.w < 44 || menu.h < 44) throw new Error(`touch target ${menu.w}x${menu.h}, needs 44x44`);

  await page.click('#menu');
  await sideAt(true);
  eq(await page.$eval('#side-scrim', (el) => getComputedStyle(el).display !== 'none'), true, 'backdrop rendered');

  await page.mouse.click(330, 420);                    // backdrop, right of the drawer
  await sideAt(false);

  // And a nav choice both navigates and closes.
  await page.click('#menu');
  await sideAt(true);
  await page.click('#nav [data-view="crew"]');
  eq(await page.$eval('#side', (el) => el.classList.contains('is-open')), false, 'drawer after nav');
  eq(await page.$eval('#v-crew', (el) => el.hidden), false, 'crew shown');
  await page.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
  return `${menu.w}x${menu.h} target, backdrop and nav both dismiss`;
});

console.log('\n  OFFLINE\n  ' + '-'.repeat(70));

await check('an unreachable database is stated, not hidden', async () => {
  if (!dbHost) return 'built with no database — nothing to state';
  // The host is blocked at DNS for this whole run; see the launch args.
  // The failure that matters is the silent one: a page that looks live, is
  // hours stale, and tells you nothing. Whatever it says, it has to say it in
  // words — the dot beside it is redundant by design.
  //
  // Wait for the status to settle rather than reading it mid-flight.
  // "Connecting…" is a truthful thing to say for the 80ms before the request
  // fails, and an earlier version of this check asserted exactly that and
  // called it a pass — the same mistake as asserting a CSS class on a sheet
  // that is still sliding.
  // `Sync` is a top-level const, so it is a script-scoped binding and never a
  // property of window — reachable by name, absent from `window.Sync`.
  await page.waitForFunction(
    () => typeof Sync !== 'undefined' && Sync.status().mode !== 'connecting',
    { timeout: 10000 },
  );
  const said = await page.evaluate(() => {
    const el = document.getElementById('sync');
    if (!el || el.hidden) return null;
    return {
      state: document.getElementById('sync-state').textContent.trim(),
      note: document.getElementById('sync-note').textContent.trim(),
    };
  });
  if (said && said.state === 'Connecting…') throw new Error('status never settled');
  if (!said) throw new Error('the sync status block never appeared');
  if (!said.state) throw new Error('sync status rendered with no words in it');
  return `"${said.state}" — ${said.note || 'no note'}`;
});

await check('edits made offline are queued rather than lost', async () => {
  if (!dbHost) return 'built with no database — nothing to queue';
  // Every edit this suite just made happened with no database. They are all in
  // localStorage, and the outbox is what will replay them on the next write.
  const queued = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ctvos.outbox.v1') || '[]').length);
  if (queued === 0) throw new Error('no operations queued after a whole suite of edits');
  const kinds = await page.evaluate(() => {
    const ops = JSON.parse(localStorage.getItem('ctvos.outbox.v1') || '[]');
    return [...new Set(ops.map((o) => `${o.table}.${o.op}`))].sort().join(', ');
  });
  return `${queued} operations held: ${kinds}`;
});

console.log('\n  CONSOLE\n  ' + '-'.repeat(70));
await check('no page errors throughout', async () => {
  if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
  return offlineNoise.length
    ? `clean — ${offlineNoise.length} database requests failed, all handled`
    : 'clean';
});

await browser.close();
console.log(
  failures.length === 0
    ? `\n  ${pass} checks pass.\n`
    : `\n  ${pass} pass, ${failures.length} FAILED.\n`
);
process.exit(failures.length ? 1 : 0);
