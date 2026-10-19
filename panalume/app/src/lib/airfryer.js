// Works out an air-fryer cook from a smart plug's power readings, so no
// air-fryer integration is needed (cards/AirFryer.svelte draws it).
//
// A cook starts when the power rises above a threshold and ends once it has
// stayed below it for longer than the "grace" time. Anything shorter than that
// is bridged: pulling the basket out to shake the food (most air fryers cut
// all power while it's out) doesn't stop the clock or split the cook in two,
// and neither does the thermostat switching the heater off for a moment.

export const DEFAULTS = { on: 50, graceMin: 3 };
const HOLD = 30e3; // a dip shorter than this is just the thermostat, not a pause
const MIN_RUN = 30e3; // power that never ran this long (a blip) isn't a cook

/** A power sensor state as watts: kW sensors are scaled, unavailable / unknown count as 0 (no power). */
export function watts(state, scale = 1) {
  const v = Number(state);
  return Number.isFinite(v) ? v * scale : 0;
}

/**
 * The latest cook in a series of readings.
 * points: [[ms, watts], …], oldest first; a reading holds until the next one
 * (the last until `now`). Returns
 *   state   'idle' | 'cooking' | 'paused' (no power, but within the grace time) | 'done'
 *   start   when the cook began
 *   end     the last moment there was power (for a finished cook: when it finished)
 *   gap     how long the power has been off now (0 while cooking)
 *   paused  total time spent in pauses of 30 s or more inside the cook
 */
export function latestCook(points, now, { on = DEFAULTS.on, grace = DEFAULTS.graceMin * 60e3 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);

  // Stretches with power, joining any that are separated by no more than the grace time.
  const runs = [];
  for (let i = 0; i < pts.length; i++) {
    const t0 = pts[i][0];
    const t1 = Math.max(t0, i + 1 < pts.length ? pts[i + 1][0] : now);
    if (pts[i][1] < on || t1 <= t0) continue;
    const prev = runs[runs.length - 1];
    if (prev && t0 - prev.end <= grace) {
      const off = t0 - prev.end;
      if (off >= HOLD) prev.paused += off;
      prev.end = t1;
      prev.active += t1 - t0;
    } else runs.push({ start: t0, end: t1, active: t1 - t0, paused: 0 });
  }

  const powered = pts.length > 0 && pts[pts.length - 1][1] >= on;
  const cooks = runs.filter((r, i) => r.active >= MIN_RUN || (powered && i === runs.length - 1));
  const r = cooks[cooks.length - 1];
  if (!r) return { state: 'idle' };

  const gap = powered ? 0 : Math.max(0, now - r.end);
  const state = gap > grace ? 'done' : gap >= HOLD ? 'paused' : 'cooking';
  return { state, start: r.start, end: r.end, gap, paused: r.paused };
}

/** 45s · 12m 05s · 1h 02m 05s */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}h ${p(m)}m ${p(x)}s` : m ? `${m}m ${p(x)}s` : `${x}s`;
}
