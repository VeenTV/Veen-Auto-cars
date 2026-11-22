// Checks cars.json: structure, the safety rules the app enforces, and the
// formulas against replies recorded on real cars (tests/recorded.json).
// Usage: node tools/check.js [cars.json]
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'cars.json');
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];
const err = (m) => errors.push(m);

const PLATFORMS = ['STELLANTIS', 'VW_MQB', 'HYUNDAI_KIA', 'TOYOTA', 'BMW', 'MERCEDES', 'GENERIC'];
const READINESS = ['TESTED', 'IN_DEVELOPMENT', 'NOT_TESTED', 'GENERIC'];
const TABLES = ['TOYOTA', 'BMW', 'MERCEDES'];
const LIST_KEYS = ['cells.D440', 'cells.D442', 'cells.D8AD'];
const KINDS = ['VOLTAGE', 'HEALTH', 'TEMPERATURE'];
const hex = (s, max, what) => {
  if (!/^(0x)?[0-9A-Fa-f]+$/.test(String(s))) { err(`${what}: not hex (${s})`); return -1; }
  const v = parseInt(String(s).replace(/^0x/, ''), 16);
  if (v > max) err(`${what}: out of range (${s})`);
  return v;
};

// ---- structure ----
if (db.schema !== 1) err('schema must be 1');
if (!/^\d{4}\.\d{1,2}\.\d{1,2}\.\d+$/.test(db.version || '')) err('bad version');
const ids = new Set();
for (const m of db.models || []) {
  if (!/^[a-z0-9-]{1,60}$/.test(m.id)) err(`model id ${m.id}`);
  if (ids.has(m.id)) err(`duplicate model ${m.id}`);
  ids.add(m.id);
  if (!PLATFORMS.includes(m.platform)) err(`${m.id}: platform ${m.platform}`);
  if (!READINESS.includes(m.readiness)) err(`${m.id}: readiness ${m.readiness}`);
  if (typeof m.name !== 'string' || typeof m.brand !== 'string') err(`${m.id}: name/brand`);
  if (m.vwVariant && !['MQB', 'MLB', 'ETRON'].includes(m.vwVariant)) err(`${m.id}: vwVariant`);
}
if (!db.models.some((m) => m.id === 'other' && m.platform === 'GENERIC')) err('generic "other" car missing');
for (const [brand, codes] of Object.entries(db.wmi || {})) for (const c of codes) if (!/^[A-Z0-9]{3}$/.test(c)) err(`VIN prefix ${brand}: ${c}`);

function checkFmt(f, where) {
  const len = f.len ?? 8, bix = f.bix ?? 0;
  if (!(len >= 1 && len <= 32) || !(bix >= 0 && bix <= 8191)) err(`${where}: bits`);
  if ((f.div ?? 1) === 0) err(`${where}: div 0`);
}
for (const [name, t] of Object.entries(db.tables || {})) {
  if (!TABLES.includes(name)) { err(`table ${name}: unknown platform`); continue; }
  const units = {};
  for (const u of t.units) {
    const svc = u.service || 'UDS';
    if (!['UDS', 'KWP'].includes(svc)) err(`${name}/${u.id}: service ${svc}`);
    hex(u.request, 0x7FF, `${name}/${u.id} request`);
    hex(u.reply, 0x7FF, `${name}/${u.id} reply`);
    hex(u.probe, svc === 'UDS' ? 0xFFFF : 0xFF, `${name}/${u.id} probe`);
    if (u.extAddr !== undefined) hex(u.extAddr, 0xFF, `${name}/${u.id} extAddr`);
    units[u.id] = u;
  }
  const unit = (x, w) => units[x.unit] || (err(`${w}: unknown unit ${x.unit}`), { service: 'UDS' });
  for (const v of t.values || []) {
    const w = `${name}/${v.unit}/${v.id} ${v.name}`;
    const u = unit(v, w);
    hex(v.id, (u.service || 'UDS') === 'UDS' ? 0xFFFF : 0xFF, w);
    if (!['FAST', 'NORMAL', 'ONCE'].includes(v.rate)) err(`${w}: rate`);
    if (v.key && !/^bms\.[A-Za-z0-9]{2,12}$/.test(v.key)) err(`${w}: key ${v.key}`);
    checkFmt(v.fmt, w);
  }
  for (const x of t.texts || []) {
    const w = `${name}/${x.unit}/${x.id} ${x.name}`;
    unit(x, w);
    if (x.list) checkFmt(x.list.fmt, w); else if (!x.template || !Array.isArray(x.fields)) err(`${w}: template/fields`); else x.fields.forEach((f) => checkFmt(f, w));
  }
  for (const s of t.series || []) {
    const w = `${name}/${s.unit}/${s.id} ${s.name}`;
    unit(s, w);
    if (!LIST_KEYS.includes(s.listKey)) err(`${w}: listKey`);
    if (!KINDS.includes(s.kind)) err(`${w}: kind`);
    if (!((s.size ?? 2) >= 1 && (s.size ?? 2) <= 4)) err(`${w}: size`);
    checkFmt(s.fmt, w);
  }
}

// ---- formulas (the same arithmetic as DidTable.Fmt in the app) ----
const bytes = (h) => (h.match(/../g) || []).map((x) => parseInt(x, 16));
function raw(d, bix, len, sign) {
  if (len < 1 || len > 32 || bix < 0 || bix + len > d.length * 8) return null;
  let v = 0n;
  for (let i = bix; i < bix + len; i++) v = (v << 1n) | BigInt((d[i >> 3] >> (7 - (i & 7))) & 1);
  if (sign && ((v >> BigInt(len - 1)) & 1n)) v -= 1n << BigInt(len);
  return Number(v);
}
function scale(f, r) {
  if (r === null) return null;
  if (f.nullFrom !== undefined && r >= f.nullFrom) return null;
  const v = (r * (f.mul ?? 1)) / (f.div ?? 1) + (f.add ?? 0);
  if (f.min !== undefined && v < f.min) return null;
  if (f.max !== undefined && v > f.max) return null;
  return v;
}
const decode = (f, d) => scale(f, raw(d, f.bix ?? 0, f.len ?? 8, !!f.sign));
function list(d, start, size, f) {
  const out = [];
  for (let i = start; i + size <= d.length; i += size) { const v = scale(f, raw(d, i * 8, size * 8, !!f.sign)); if (v !== null) out.push(v); }
  return out;
}
const fix = (v, n) => v.toFixed(n);
function text(x, d) {
  if (x.list) {
    let vals = list(d, x.list.start ?? 0, x.list.size ?? 2, x.list.fmt).slice(0, x.list.count ?? 64);
    if (x.list.range) vals = vals.filter((v) => v >= x.list.range[0] && v <= x.list.range[1]);
    return vals.length ? vals.map((v) => fix(v, x.decimals ?? 1)).join(x.sep ?? ' / ') + (x.suffix ?? '') : null;
  }
  const parts = x.fields.map((f) => { const v = decode(f, d); return v === null ? null : fix(v, f.decimals ?? 1); });
  return parts.includes(null) ? null : parts.reduce((s, p, i) => s.split(`{${i}}`).join(p), x.template);
}

const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'recorded.json'), 'utf8'));
let checked = 0;
for (const c of rec.cases) {
  const t = db.tables[c.table];
  const d = bytes(c.data);
  const w = `${c.car} ${c.table} ${c.id || c.series || c.text}`;
  if (!t) { err(`${w}: table missing`); continue; }
  if (c.expect) {
    for (const [name, want] of Object.entries(c.expect)) {
      const v = t.values.find((x) => x.unit === c.unit && x.id.toUpperCase() === c.id.toUpperCase() && x.name === name);
      if (!v) { err(`${w}: value "${name}" missing`); continue; }
      const got = decode(v.fmt, d);
      if (got === null || Math.abs(got - want) > 0.0015) err(`${w}: ${name} = ${got}, recorded ${want}`);
      checked++;
    }
  }
  if (c.series) {
    const s = t.series.find((x) => x.id.toUpperCase() === c.series.toUpperCase());
    const vals = s ? list(d, s.start ?? 0, s.size ?? 2, s.fmt) : [];
    if (vals.length !== c.expectCount) err(`${w}: ${vals.length} values, recorded ${c.expectCount}`);
    c.expectFirst.forEach((want, i) => { if (Math.abs(vals[i] - want) > 0.00002) err(`${w}: value ${i + 1} = ${vals[i]}, recorded ${want}`); });
    checked++;
  }
  if (c.text) {
    const x = t.texts.find((y) => y.id.toUpperCase() === c.text.toUpperCase() && y.name === c.name);
    const got = x ? text(x, d) : null;
    if (got !== c.expectText) err(`${w}: "${got}", recorded "${c.expectText}"`);
    checked++;
  }
}

if (errors.length) {
  console.error(`cars.json: ${errors.length} problem(s)`);
  errors.forEach((e) => console.error(' - ' + e));
  process.exit(1);
}
console.log(`cars.json OK: ${db.models.length} models, ${Object.keys(db.tables).length} tables, ${checked} recorded checks`);
