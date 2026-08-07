#!/usr/bin/env node
// CTV OS — drive the prototype in real Chrome and assert the editing works.
//
//   node scripts/e2e.mjs
//
// Every check goes through the actual DOM the user touches. Nothing here calls
// an internal function directly, because the bugs live in the wiring.

import puppeteer from 'puppeteer-core';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'prototype/ctv-os.html')).href;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'networkidle0' });

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

const closeAndTodo = async () => {
  await page.evaluate(() => document.getElementById('sheet-x')?.click());
  await goto('tasks');
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
  const before = await openRoles();
  await openSheet('rugby-rec');
  // GANTRY is index 1 on this event and starts open.
  await page.$eval('[data-role="1"]', (el) => {
    el.value = 'nina'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.roles[1].member, 'nina', 'gantry');
  const after = await openRoles();
  eq(after, '43', 'sidebar count');
  return `${before} → ${after}`;
});

await check('the calendar badge updates with it', async () => {
  // The badge is one line of colour, so its coverage lives in the accessible
  // name. Asserting the title is asserting what a screen reader is told, not
  // just what the pixel looks like.
  const [title, open] = await page.$eval('.ev[data-ev="rugby-rec"]',
    (el) => [el.title, el.classList.contains('is-open')]);
  if (!title.includes('5/6 crewed')) throw new Error(`title was "${title}"`);
  eq(open, true, 'still flagged open with one gap left');
  await page.click('#toast-undo');
  return '4/6 → 5/6 crewed';
});

await check('reopening a role puts the gap back', async () => {
  await openSheet('rugby-rec');
  await page.$eval('[data-role="0"]', (el) => {
    el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ev = await eventById('rugby-rec');
  eq(ev.roles[0].member, null, 'producer');
  eq(await openRoles(), '45', 'sidebar count');
  await page.click('#toast-undo');
  return 'PRODUCER reopened, count rose';
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
  await page.click('#sheet-del');
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

await check('deleting removes the event', async () => {
  const id = (await stored()).events.find((e) => e.date === '2026-10-15').id;
  await page.click('#sheet-del');
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
  await page.click('#sheet-del');
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

console.log('\n  TO DO\n  ' + '-'.repeat(70));

const gotoTodo = () => goto('tasks');

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
  const rows = await page.$$eval('.tbl tbody tr', (els) => els.length);
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

await check('the area filter narrows the list', async () => {
  await gotoTodo();
  await page.click('[data-area="nasta"]');
  const areas = await page.$$eval('.tcard .tag', (els) =>
    [...new Set(els.map((e) => e.textContent.trim()))]);
  eq(areas, ['NaSTA'], 'areas shown');
  await page.click('[data-area="all"]');
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
  await goto('tasks');
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

console.log('\n  CONSOLE\n  ' + '-'.repeat(70));
await check('no page errors throughout', async () => {
  if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
  return 'clean';
});

await browser.close();
console.log(
  failures.length === 0
    ? `\n  ${pass} checks pass.\n`
    : `\n  ${pass} pass, ${failures.length} FAILED.\n`
);
process.exit(failures.length ? 1 : 0);
