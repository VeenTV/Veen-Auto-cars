// Checks dtc.json: structure, all three languages, ranges, combinations, and
// the combination examples in tests/dtc-cases.json.
// Usage: node tools/check-dtc.js [dtc.json]
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'dtc.json');
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];
const err = (m) => errors.push(m);

const LANGS = ['en', 'fi', 'sv'];
const AREAS = ['battery', 'hybrid', 'charging', 'engine', 'fuel', 'emissions', 'transmission', 'electrical', 'network', 'chassis', 'body', 'other'];
const SEVS = ['low', 'medium', 'high', 'critical'];
const CODE = /^[PCBU][0-3][0-9A-F]{3}$/;
// A combination pattern: one code, or a range "P0A00-P0AFF".
const PATTERN = /^[PCBU][0-3][0-9A-F]{3}(-[PCBU][0-3][0-9A-F]{3})?$/;
const num = (c) => ('PCBU'.indexOf(c[0]) << 16) | parseInt(c.slice(1), 16);

if (db.schema !== 1) err('schema must be 1');
if (!/^\d{4}\.\d{1,2}\.\d{1,2}\.\d+$/.test(db.version || '')) err('bad version');
const advice = db.advice || {};
for (const [k, a] of Object.entries(advice)) for (const l of LANGS) if (typeof a[l] !== 'string' || !a[l]) err(`advice ${k}: ${l} missing`);

for (const [k, f] of Object.entries(db.failureTypes || {})) {
  if (!/^[0-9A-F]{2}$/.test(k)) err(`failure type ${k}: not a hex byte`);
  for (const l of LANGS) if (typeof f[l] !== 'string' || !f[l]) err(`failure type ${k}: ${l} missing`);
}

function entry(e, w) {
  if (!AREAS.includes(e.area)) err(`${w}: area ${e.area}`);
  if (!SEVS.includes(e.sev)) err(`${w}: severity ${e.sev}`);
  if (e.advice !== undefined && !advice[e.advice]) err(`${w}: unknown advice ${e.advice}`);
  for (const l of LANGS) {
    const t = e[l];
    if (!t || typeof t.title !== 'string' || !t.title || typeof t.text !== 'string' || !t.text) err(`${w}: ${l} title/text missing`);
    else if (t.title.length > 90 || t.text.length > 500) err(`${w}: ${l} text too long`);
  }
}
for (const [code, e] of Object.entries(db.codes || {})) {
  if (!CODE.test(code)) err(`code ${code}: bad format`);
  entry(e, code);
}
for (const [i, r] of (db.ranges || []).entries()) {
  const w = `range ${r.from}-${r.to}`;
  if (!CODE.test(r.from) || !CODE.test(r.to) || r.from[0] !== r.to[0] || num(r.from) > num(r.to)) err(`${w}: bad bounds`);
  entry(r, w);
}
for (const [brand, codes] of Object.entries(db.brands || {})) {
  if (typeof brand !== 'string' || !brand) err('brand name');
  for (const [code, e] of Object.entries(codes)) {
    if (!CODE.test(code)) err(`${brand} ${code}: bad format`);
    entry(e, `${brand} ${code}`);
  }
}
const ids = new Set();
for (const c of db.combos || []) {
  const w = `combination ${c.id}`;
  if (!/^[a-z0-9-]{1,40}$/.test(c.id || '') || ids.has(c.id)) err(`${w}: bad or duplicate id`);
  ids.add(c.id);
  const groups = ['all', 'any', 'also'].filter((g) => c[g] !== undefined);
  if (!groups.length) err(`${w}: no codes`);
  for (const g of groups) {
    if (!Array.isArray(c[g]) || !c[g].length) err(`${w}: ${g} must be a non-empty list`);
    else for (const p of c[g]) if (!PATTERN.test(p)) err(`${w}: pattern ${p}`);
  }
  for (const m of ['anyMin', 'alsoMin']) if (c[m] !== undefined && !(Number.isInteger(c[m]) && c[m] >= 1 && c[m] <= 20)) err(`${w}: ${m}`);
  if (c.alsoMin !== undefined && c.also === undefined) err(`${w}: alsoMin without also`);
  entry({ ...c, area: 'other' }, w);
}

// ---- matching, as the app does it ----
const matches = (p, code) => {
  const [a, b] = p.split('-');
  return b === undefined ? code === a : (code[0] === a[0] && num(code) >= num(a) && num(code) <= num(b));
};
const count = (pats, codes) => codes.filter((c) => pats.some((p) => matches(p, c))).length;
function combos(codes) {
  const base = [...new Set(codes.map((c) => c.slice(0, 5)))];
  return (db.combos || []).filter((c) =>
    (c.all || []).every((p) => base.some((x) => matches(p, x))) &&
    (c.any === undefined || count(c.any, base) >= (c.anyMin ?? 1)) &&
    (c.also === undefined || count(c.also, base) >= (c.alsoMin ?? 1))).map((c) => c.id);
}
function describe(code, brand) {
  const b = code.slice(0, 5);
  const own = (db.brands?.[brand] || {})[b] || db.codes[b];
  if (own) return own;
  const hits = (db.ranges || []).filter((r) => matches(`${r.from}-${r.to}`, b));
  hits.sort((x, y) => (num(x.to) - num(x.from)) - (num(y.to) - num(y.from)));
  return hits[0] || null;
}
let checked = 0;
const casesFile = path.join(__dirname, '..', 'tests', 'dtc-cases.json');
for (const t of JSON.parse(fs.readFileSync(casesFile, 'utf8'))) {
  const w = `case ${t.codes.join(' ')}`;
  if (t.combos) {
    const got = combos(t.codes).sort().join(',');
    if (got !== [...t.combos].sort().join(',')) err(`${w}: combinations ${got || '(none)'}, expected ${t.combos.join(',') || '(none)'}`);
    checked++;
  }
  for (const [code, title] of Object.entries(t.titles || {})) {
    const d = describe(code, t.brand);
    if ((d?.en.title ?? null) !== title) err(`${w}: ${code} "${d?.en.title}", expected "${title}"`);
    checked++;
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`${errors.length} problem(s) in ${file}`);
  process.exit(1);
}
console.log(`dtc.json OK: ${Object.keys(db.codes).length} codes, ${db.ranges.length} ranges, ${Object.keys(db.brands).length} brands, ${db.combos.length} combinations, ${checked} case checks`);
