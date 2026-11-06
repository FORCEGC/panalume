// Climate schedule stored as compact JSON in one input_text helper (255 characters).
//   [["0630","1111100","h",20], ["2200","1111111","r",19,23]]
//   [start HHMM, days Mon..Sun as 1/0, mode, temperature]
//   mode letters: h heat, c cool, o off, r heat_cool, a auto, d dry, f fan_only
//   heat_cool (and any range mode) adds the high temperature as a fifth value.
// The package in docs/climate-schedule.yaml reads the same string. scheduledAt()
// below and that package's "due" template must stay in step.

export const MAX_SLOTS = 8;
export const MAX_LEN = 255;
export const GRACE_MS = 90000;
export const TOL = 0.05;
export const APPLY_SCRIPT = 'script.climate_schedule_apply';
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const MODE_ORDER = ['off', 'cool', 'heat', 'heat_cool', 'auto', 'dry', 'fan_only'];

export const MODE_INFO = {
  off: { code: 'o', icon: 'mdi:power', label: 'Off' },
  cool: { code: 'c', icon: 'mdi:snowflake', label: 'Cool' },
  heat: { code: 'h', icon: 'mdi:fire', label: 'Heat' },
  heat_cool: { code: 'r', icon: 'mdi:sun-snowflake-variant', label: 'Heat/Cool' },
  auto: { code: 'a', icon: 'mdi:thermostat-auto', label: 'Auto' },
  dry: { code: 'd', icon: 'mdi:water-percent', label: 'Dry' },
  fan_only: { code: 'f', icon: 'mdi:fan', label: 'Fan' },
};

const CODE = Object.fromEntries(Object.entries(MODE_INFO).map(([mode, info]) => [info.code, mode]));
const REV = Object.fromEntries(Object.entries(MODE_INFO).map(([mode, info]) => [mode, info.code]));
const MODE_RE = /^[a-z][a-z0-9_]{0,20}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_RE = /^([01]\d|2[0-3])[0-5]\d$/;

const pad = (n) => String(n).padStart(2, '0');
export const mins = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const byTime = (a, b) => mins(a.t) - mins(b.t);
export const sortSlots = (slots) => [...slots].sort(byTime);
const wdOf = (date) => (date.getDay() + 6) % 7;
const at = (day, m) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);

export function cleanNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : null;
}

export function fmtNum(v) {
  const n = cleanNum(v);
  return n == null ? '—' : String(n);
}

/** Helpers created by docs/climate-schedule.yaml, named from the climate entity id. */
export function helperIds(entityId) {
  const slug = String(entityId || '').split('.')[1] || '';
  const ok = /^[a-z0-9_]+$/.test(slug);
  return {
    slug: ok ? slug : '',
    schedule: ok ? `input_text.${slug}_climate_schedule` : '',
    enabled: ok ? `input_boolean.${slug}_climate_schedule_enabled` : '',
    apply: APPLY_SCRIPT,
  };
}

export function usesFahrenheit(attrs) {
  const unit = attrs?.temperature_unit;
  if (unit === '°F' || unit === 'F') return true;
  if (unit === '°C' || unit === 'C') return false;
  const max = Number(attrs?.max_temp);
  return Number.isFinite(max) && max > 45;
}

/** Min, max and step from the climate entity, with a mild fallback when it has not reported them. */
export function tempBounds(attrs = {}) {
  const f = usesFahrenheit(attrs);
  const stepIn = Number(attrs?.target_temp_step);
  const step = Number.isFinite(stepIn) && stepIn > 0 ? stepIn : (f ? 1 : 0.5);
  const minIn = Number(attrs?.min_temp);
  const maxIn = Number(attrs?.max_temp);
  const min = Number.isFinite(minIn) ? minIn : (f ? 45 : 7);
  const max = Number.isFinite(maxIn) ? maxIn : (f ? 95 : 35);
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    step,
    f,
    unit: attrs?.temperature_unit || (f ? '°F' : '°C'),
  };
}

export function clampTemp(v, bounds) {
  const n = Number(v);
  const stepped = Number.isFinite(n) ? Math.round(n / bounds.step) * bounds.step : bounds.min;
  return cleanNum(Math.min(bounds.max, Math.max(bounds.min, stepped)));
}

/**
 * How a mode is set on this entity.
 * supported_features bit 0 = single target, bit 1 = low/high range (Home Assistant climate).
 * heat_cool uses the range when the entity supports it. auto uses the range only when
 * that is the only target the entity accepts.
 */
export function tempKind(mode, attrs = {}) {
  if (!mode || mode === 'off' || mode === 'fan_only') return 'none';
  const feats = Number(attrs?.supported_features);
  const known = Number.isFinite(feats) && feats > 0;
  const single = known && (feats & 1) !== 0;
  const range = known && (feats & 2) !== 0;
  if (mode === 'heat_cool') return range || !single ? 'range' : 'single';
  if (range && !single) return 'range';
  if (mode === 'dry') return single ? 'single' : 'none';
  if (single || !known) return 'single';
  return 'none';
}

/** Modes the entity lists, in a stable order. Falls back to off/cool/heat before attributes arrive. */
export function modesFor(attrs, extra) {
  const have = Array.isArray(attrs?.hvac_modes) && attrs.hvac_modes.length
    ? attrs.hvac_modes.map(String)
    : ['off', 'cool', 'heat'];
  const ordered = MODE_ORDER.filter((m) => have.includes(m));
  const rest = have.filter((m) => !ordered.includes(m) && MODE_RE.test(m));
  if (extra && !ordered.includes(extra) && !rest.includes(extra) && (MODE_INFO[extra] || MODE_RE.test(String(extra)))) rest.push(extra);
  return [...ordered, ...rest];
}

function decodeMode(v) {
  const s = String(v);
  if (CODE[s]) return CODE[s];
  if (MODE_INFO[s]) return s;
  if (MODE_RE.test(s)) return s;
  return null;
}

function encodeMode(mode) {
  if (REV[mode]) return REV[mode];
  return MODE_RE.test(String(mode)) ? String(mode) : null;
}

export function normalizeSlot(slot, attrs) {
  const bounds = tempBounds(attrs);
  const mode = slot.mode || 'off';
  const kind = tempKind(mode, attrs);
  const days = Array.from({ length: 7 }, (_, i) => !!slot.days?.[i]);
  const t = TIME_RE.test(slot.t) ? slot.t : '00:00';
  const fallback = bounds.f ? 72 : 22;
  if (kind === 'none') return { t, days, mode, temp: cleanNum(slot.temp) ?? clampTemp(fallback, bounds) };
  if (kind === 'range') {
    let low = clampTemp(slot.temp ?? (bounds.f ? 68 : 20), bounds);
    let high = clampTemp(slot.tempHigh ?? low + (bounds.f ? 6 : 3), bounds);
    if (high - low < bounds.step) high = clampTemp(low + bounds.step, bounds);
    if (high - low < bounds.step) low = clampTemp(high - bounds.step, bounds);
    return { t, days, mode, temp: low, tempHigh: high };
  }
  return { t, days, mode, temp: clampTemp(slot.temp ?? fallback, bounds) };
}

export function parseSchedule(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const hhmm = String(row[0]).padStart(4, '0');
    if (!HHMM_RE.test(hhmm)) continue;
    const mode = decodeMode(row[2]);
    const temp = cleanNum(row[3]);
    if (!mode || temp == null) continue;
    const days = String(row[1]).padEnd(7, '0').slice(0, 7).split('').map((c) => c === '1');
    const slot = { t: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, days, mode, temp };
    if (row.length >= 5) {
      const high = cleanNum(row[4]);
      if (high != null) {
        slot.tempHigh = high;
        if (slot.tempHigh < slot.temp) [slot.temp, slot.tempHigh] = [slot.tempHigh, slot.temp];
      }
    }
    out.push(slot);
  }
  return sortSlots(out).slice(0, MAX_SLOTS);
}

export function serializeSchedule(slots) {
  const rows = [];
  for (const slot of sortSlots(slots)) {
    const mode = encodeMode(slot.mode);
    const temp = cleanNum(slot.temp);
    if (!mode || temp == null || !TIME_RE.test(slot.t)) continue;
    const days = Array.from({ length: 7 }, (_, i) => (slot.days?.[i] ? '1' : '0')).join('');
    const row = [slot.t.replace(':', ''), days, mode, temp];
    const high = cleanNum(slot.tempHigh);
    if (high != null) row.push(high);
    rows.push(row);
    if (rows.length >= MAX_SLOTS) break;
  }
  return JSON.stringify(rows);
}

/** The slot in force at `now`: the latest one that has started, looking back up to a week. */
export function scheduledAt(slots, now) {
  const nm = now.getHours() * 60 + now.getMinutes();
  for (let k = 0; k <= 7; k++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - k);
    const wd = wdOf(day);
    const list = slots.filter((s) => s.days[wd] && (k > 0 || mins(s.t) <= nm)).sort(byTime);
    if (list.length) {
      const slot = list[list.length - 1];
      return { slot, since: at(day, mins(slot.t)) };
    }
  }
  return null;
}

/** The next slot that will start after `now`. */
export function nextAfter(slots, now) {
  const nm = now.getHours() * 60 + now.getMinutes();
  for (let k = 0; k <= 7; k++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
    const wd = wdOf(day);
    const list = slots.filter((s) => s.days[wd] && (k > 0 || mins(s.t) > nm)).sort(byTime);
    if (list.length) return { slot: list[0], when: at(day, mins(list[0].t)) };
  }
  return null;
}

/** Today as consecutive segments [{from, to (minutes), slot|null}] covering 0..1440. */
export function timeline(slots, now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todays = slots.filter((s) => s.days[wdOf(now)]).sort(byTime);
  const before = scheduledAt(slots, new Date(start.getTime() - 60000));
  let cur = before ? before.slot : null;
  let from = 0;
  const segs = [];
  for (const slot of todays) {
    const m = mins(slot.t);
    if (m > from) segs.push({ from, to: m, slot: cur });
    cur = slot;
    from = m;
  }
  segs.push({ from, to: 1440, slot: cur });
  return segs;
}

export function fmtClock(m, hour12 = true) {
  const h = Math.floor(m / 60) % 24;
  const mm = ((m % 60) + 60) % 60;
  if (!hour12) return `${pad(h)}:${pad(mm)}`;
  return `${h % 12 || 12}:${pad(mm)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function fmtWhen(when, now, hour12 = true) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(when) - day(now)) / 86400000);
  const word = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : DAY_NAMES[wdOf(when)].slice(0, 3);
  return `${word} ${fmtClock(when.getHours() * 60 + when.getMinutes(), hour12)}`;
}

export function slotText(slot, { unit = '°', kind = 'single', label } = {}) {
  const text = label || MODE_INFO[slot?.mode]?.label || String(slot?.mode || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  if (!slot || kind === 'none' || slot.mode === 'off') return text;
  const u = unit === '°F' || unit === '°C' ? unit : '°';
  if (kind === 'range') return `${text} ${fmtNum(slot.temp)}–${fmtNum(slot.tempHigh)}${u}`;
  return `${text} ${fmtNum(slot.temp)}${u}`;
}

function attrNum(...values) {
  for (const v of values) {
    const n = Number(v);
    if (v != null && v !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

/** True when the entity is already at this slot's target. Missing attributes count as "not yet". */
export function tempMatches(entity, slot) {
  const kind = tempKind(slot.mode, entity?.attributes);
  if (kind === 'none') return true;
  const a = entity?.attributes || {};
  const want = cleanNum(slot.temp);
  if (want == null) return false;
  if (kind === 'range') {
    const hi = cleanNum(slot.tempHigh);
    const low = attrNum(a.target_temp_low);
    const high = attrNum(a.target_temp_high);
    if (low == null || high == null || hi == null) return false;
    return Math.abs(low - want) <= TOL && Math.abs(high - hi) <= TOL;
  }
  const cur = attrNum(a.temperature, a.target_temp_low, a.target_temp_high);
  if (cur == null) return false;
  return Math.abs(cur - want) <= TOL;
}

/** True when the unit isn't doing what the schedule says. A missing target is not treated as a hand change. */
export function differs(slot, entity) {
  if (!entity || entity.state === 'unavailable' || entity.state === 'unknown') return false;
  if (entity.state !== slot.mode) return true;
  const kind = tempKind(slot.mode, entity.attributes);
  if (kind === 'none') return false;
  const a = entity.attributes || {};
  if (kind === 'range') {
    const low = attrNum(a.target_temp_low);
    const high = attrNum(a.target_temp_high);
    if (low == null || high == null || slot.tempHigh == null) return false;
    return Math.abs(low - slot.temp) > TOL || Math.abs(high - slot.tempHigh) > TOL;
  }
  const cur = attrNum(a.temperature, a.target_temp_low, a.target_temp_high);
  if (cur == null) return false;
  return Math.abs(cur - slot.temp) > TOL;
}

const COMFORT = {
  f: {
    heat: [68, 64, 68, 62],
    cool: [74, 78, 74, 72],
    heat_cool: [[68, 74], [64, 78], [68, 74], [62, 72]],
  },
  c: {
    heat: [20, 18, 20, 17],
    cool: [22, 24, 22, 21],
    heat_cool: [[19, 23], [17, 25], [19, 23], [16, 21]],
  },
};

/** Four everyday times. Temperatures follow the entity's unit and are clamped to its range. */
export function starterSlots(mode, attrs) {
  const bounds = tempBounds(attrs);
  const table = bounds.f ? COMFORT.f : COMFORT.c;
  const kind = tempKind(mode, attrs);
  const days = Array(7).fill(true);
  const base = mode === 'heat' ? table.heat : table.cool;
  return ['06:30', '09:00', '17:30', '22:00'].map((t, i) => normalizeSlot({
    t,
    days,
    mode,
    temp: kind === 'range' ? table.heat_cool[i][0] : base[i],
    tempHigh: kind === 'range' ? table.heat_cool[i][1] : null,
  }, attrs));
}
