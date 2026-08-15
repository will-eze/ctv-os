#!/usr/bin/env node
// CTV OS — palette verification for Studio Essential.
//
//   node scripts/contrast.mjs            # tables + pass/fail
//   node scripts/contrast.mjs --json     # machine readable
//
// This script does two jobs, and the first matters more than the second.
//
//   1. DRIFT. The palette is not ours. It comes from the Stitch design system
//      "Studio Essential" (stitch/design-system.json), and the prototype
//      hand-copies it into CSS custom properties because the artifact CSP
//      blocks Tailwind's CDN. Hand-copying is exactly the kind of thing that
//      rots, so every token is compared back to the design system byte for
//      byte. A colour that has quietly drifted fails here.
//
//   2. CONTRAST. Studio Essential ships colours, not guarantees. Every
//      foreground/background pair the interface actually puts on screen is
//      measured against WCAG AA. Where a pair is set with opacity, the
//      composite is computed — an opacity is a contrast change, and the old
//      version of this file could not see them at all.
//
// Exit code 1 if any token has drifted or any required pair is under floor.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');

// --- sRGB -> WCAG relative luminance --------------------------------------
// Plain hex this time. The previous palette was authored in OKLCH and needed
// the Oklab transform; Studio Essential is specified in hex, so converting to
// OKLCH and back would only add rounding error to a number used as a gate.
const hex = (s) => {
  const h = s.trim().replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
};

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (s) => {
  const [r, g, b] = hex(s).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// Source-over compositing, in sRGB space, the way a browser paints it.
const over = (fg, bg, alpha) => {
  const f = hex(fg), b = hex(bg);
  const out = f.map((c, i) => c * alpha + b[i] * (1 - alpha));
  return '#' + out.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
};

const ratio = (a, b) => {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// --- 1. Drift -------------------------------------------------------------
const ds = JSON.parse(readFileSync(join(root, 'stitch/design-system.json'), 'utf8'));
const named = ds.designSystem?.theme?.namedColors ?? ds.theme?.namedColors ?? ds.namedColors;
if (!named) {
  console.error('  design-system.json has no namedColors — did the Stitch export change shape?');
  process.exit(1);
}

const css = readFileSync(join(root, 'prototype/ctv-os.html'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const vars = Object.fromEntries(
  [...rootBlock.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)]
    .map((m) => [m[1], m[2].toLowerCase()])
);

// Which prototype token is which Studio Essential named colour. Anything not
// listed is either a shape/z-index token or one of the two documented
// exceptions below.
const MAP = {
  card: 'surface-container-lowest',
  primary: 'primary',          'primary-c': 'primary-container',
  'on-primary': 'on-primary',  'on-primary-c': 'on-primary-container',
  tint: 'surface-tint',
  'on-surface': 'on-surface',  'on-surface-var': 'on-surface-variant',
  secondary: 'secondary',      outline: 'outline',
  'outline-var': 'outline-variant',
  error: 'error',              'error-c': 'error-container',
  'on-error-c': 'on-error-container',
  tertiary: 'tertiary',
};

// Two kinds of documented departure from Studio Essential, both pinned here so
// they are guarded against silent drift even though they no longer match Stitch.
//
//   1. The surface ramp. Stitch's surfaces are a cool blue-grey; the station
//      manager asked for the blue tint gone, so the six surface tokens are
//      retuned to a warm neutral grey. Everything else — green, error, text,
//      outline — is still Stitch's, and still checked against it in MAP above.
//   2. The month grid rules and out-of-month fill, neutralised to match (1)
//      rather than Stitch's slate.
const EXCEPTIONS = {
  bg:        ['#f7f7f5', 'neutral canvas — blue tint removed on request'],
  low:       ['#f3f3f1', 'neutral sidebar — blue tint removed on request'],
  container: ['#ededea', 'neutral hover surface — blue tint removed on request'],
  high:      ['#e6e6e2', 'neutral active-nav surface — blue tint removed on request'],
  highest:   ['#e0e0dc', 'neutral tag fill — blue tint removed on request'],
  dim:       ['#d6d6d1', 'neutral surface-dim — blue tint removed on request'],
  grid:      ['#e6e6e2', 'neutral month-grid rule'],
  'grid-bg': ['#f4f4f2', 'neutral out-of-month cell fill'],
  warn:      ['#8a5000', 'kit away-on-a-clock amber — palette ships only error red'],
  info:      ['#00629a', 'coverage-tag blue ink — palette ships only error red + the kit amber'],
};

// The export writes namedColors with underscores (surface_container_low) while
// the Tailwind config in the same export uses hyphens. Normalise, so a rename
// on their side surfaces as drift rather than as "no such colour".
const look = (name) => named[name] ?? named[name.replace(/-/g, '_')];

const drift = [];
for (const [token, name] of Object.entries(MAP)) {
  const mine = vars[token];
  const theirs = String(look(name) ?? '').toLowerCase();
  if (!mine) drift.push(`--${token} is missing from :root`);
  else if (!theirs) drift.push(`design system has no colour named "${name}"`);
  else if (mine !== theirs) drift.push(`--${token} is ${mine}, Studio Essential says ${theirs} (${name})`);
}
for (const [token, [want]] of Object.entries(EXCEPTIONS)) {
  if (vars[token] !== want) drift.push(`--${token} is ${vars[token]}, documented exception is ${want}`);
}

// --- 2. Contrast ----------------------------------------------------------
const C = { ...Object.fromEntries(Object.entries(vars)), white: '#ffffff' };

// floor 4.5 = body text; 3.0 = large text (>=24px, or >=18.7px bold) and the
// boundaries of controls. Every row names where it is actually used, because a
// pair nobody renders is a pair nobody should be defending.
const PAIRS = [
  // fg, bg, floor, where
  ['on-surface',      'card',      4.5, 'body text and headings on a card'],
  ['on-surface',      'bg',        4.5, 'body text on the canvas'],
  ['on-surface',      'low',       4.5, 'text on the sidebar'],
  ['on-surface-var',  'card',      4.5, 'page-head subtitle, .muted'],
  ['on-surface-var',  'bg',        4.5, 'brief text on the canvas'],
  ['on-surface-var',  'highest',   4.5, '.tag default'],
  ['on-surface-var',  'high',      4.5, '.col-n board column count'],
  // The sync line lives in the sidebar, so it is measured against --low rather
  // than --card. Whether the year on screen is the year everyone else is seeing
  // is not a decorative detail, and it is set in the one place in the interface
  // whose background is not white.
  ['on-surface-var',  'low',       4.5, '.sync-line — Live / Offline / Read only'],
  ['error',           'low',       4.5, '.sync-note when the database rejects a write'],
  ['secondary',       'card',      4.5, '.dimmed, table meta, .stat-note'],
  ['secondary',       'low',       4.5, 'sidebar nav labels, weekday header, .sync-note'],
  ['secondary',       'bg',        4.5, 'crew card key labels'],
  ['secondary',       'container', 4.5, '.seg unselected'],
  ['primary',         'card',      4.5, 'links, Today, .person-role'],
  ['primary',         'high',      4.5, 'active nav item'],
  ['on-surface',      'container', 4.5, '.ev badge default title'],
  ['primary',         'low',       4.5, '.assign inside a hover'],
  ['on-primary',      'primary',   4.5, 'primary button, selected date card'],
  ['on-primary-c',    'primary-c', 4.5, '.tag-primary'],
  ['on-error-c',      'error-c',   4.5, '.tag-error, Missing Requirements, open bay'],
  ['error',           'card',      4.5, 'overdue due date, clash text'],
  ['error',           'bg',        4.5, 'overdue in the table'],
  ['warn',            'card',      4.5, 'kit "Out" / "Booked" status word and badge'],
  ['warn',            'bg',        4.5, 'kit "Out" / "Booked" status on the canvas'],

  // The three coverage colour tags: each dark ink measured on its own light
  // fill (the badge tint and the worded chip), and blue also on white and on the
  // canvas because it is used as tag text on the legend and schedule. Green
  // reuses the primary and yellow the kit amber, so only their fills are new.
  ['primary',         'cov-green-bg',  4.5, 'coverage green tag ink on its fill'],
  ['warn',            'cov-yellow-bg', 4.5, 'coverage yellow tag ink on its fill'],
  ['info',            'cov-blue-bg',   4.5, 'coverage blue tag ink on its fill'],
  ['info',            'card',          4.5, 'coverage blue tag on white'],
  ['info',            'bg',            4.5, 'coverage blue tag on the canvas'],
  ['white',           'on-surface', 4.5, 'toast'],
  // Large text only: the four overview numbers are 32px/700.
  ['error',           'card',      3.0, 'stat value, 32px bold'],

  // WCAG 1.4.11 asks 3:1 of what is *required to identify* a component. A text
  // field is empty until you type, so its border is the only thing saying a
  // field is there — that boundary is load-bearing and takes the 3:1. Stitch's
  // export puts outline-variant on inputs, which measures 1.70:1; CTV OS uses
  // `outline` there instead, which is the same design system's own token for
  // boundaries that need contrast.
  ['outline',         'card',      3.0, 'text field, select and textarea border'],

  // Card borders and month-grid rules are not in that category: the card is
  // already identified by its white fill and shadow against the canvas, and a
  // day cell by its number and position. They are decorative separators, so
  // the only requirement is that they stay visible at all.
  ['outline-var',     'card',      1.2, 'card border (decorative separator)'],
  ['outline-var',     'bg',        1.2, 'card border on the canvas (decorative)'],
  ['grid',            'card',      1.2, 'month grid rule (decorative separator)'],
];

// Pairs the interface paints with opacity: white text at 85% on a green pill is
// not white text. Each row composites the foreground over its own background
// and then measures against that same background, which is what the eye gets.
const ALPHA = [
  ['white',      'primary', 0.85, 4.5, 'current month label in the ribbon'],
  ['white',      'primary', 0.90, 4.5, 'selected day label in the week strip'],
  ['on-surface', 'card',    0.28, 1.2, 'search non-match, deliberately faded'],
];

const rows = [];
for (const [fg, bg, floor, where] of PAIRS) {
  if (!C[fg] || !C[bg]) { rows.push({ fg, bg, r: 0, floor, where, ok: false, note: 'missing token' }); continue; }
  const r = ratio(C[fg], C[bg]);
  rows.push({ fg, bg, hexFg: C[fg], hexBg: C[bg], r, floor, where, ok: r >= floor });
}
for (const [fg, bg, a, floor, where] of ALPHA) {
  const composed = over(C[fg], C[bg], a);
  const r = ratio(composed, C[bg]);
  rows.push({ fg: `${fg} @${a}`, bg, hexFg: composed, hexBg: C[bg], r, floor, where, ok: r >= floor });
}

const fails = rows.filter((x) => !x.ok);

// --- Report ---------------------------------------------------------------
if (json) {
  console.log(JSON.stringify({ drift, rows, ok: !drift.length && !fails.length }, null, 2));
  process.exit(drift.length || fails.length ? 1 : 0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  STUDIO ESSENTIAL — TOKEN DRIFT');
console.log('  ' + '-'.repeat(74));
if (drift.length === 0) {
  console.log(`  ${Object.keys(MAP).length} tokens match stitch/design-system.json exactly.`);
  for (const [t, [v, why]] of Object.entries(EXCEPTIONS)) console.log(`  --${pad(t, 10)} ${v}  documented exception: ${why}`);
} else {
  for (const d of drift) console.log(`  FAIL  ${d}`);
}

console.log('\n  CONTRAST (WCAG 2.1, sRGB)');
console.log('  ' + '-'.repeat(74));
console.log(`  ${pad('foreground', 16)}${pad('on', 12)}${pad('ratio', 8)}${pad('floor', 7)}where`);
for (const x of rows) {
  const mark = x.ok ? ' ' : '!';
  console.log(`${mark} ${pad(x.fg, 16)}${pad(x.bg, 12)}${pad(x.r.toFixed(2), 8)}${pad(x.floor.toFixed(1), 7)}${x.where}`);
}

console.log('');
if (!drift.length && !fails.length) {
  const min = rows.reduce((a, b) => (a.r < b.r ? a : b));
  console.log(`  ${rows.length} pairs pass. Tightest is ${min.fg} on ${min.bg} at ${min.r.toFixed(2)}:1 (${min.where}).\n`);
} else {
  for (const f of fails) console.log(`  FAIL  ${f.fg} on ${f.bg} is ${f.r.toFixed(2)}:1, needs ${f.floor} — ${f.where}`);
  console.log('');
}
process.exit(drift.length || fails.length ? 1 : 0);
