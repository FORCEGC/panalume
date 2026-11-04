<script module>
  import { states } from '../lib/ha.svelte.js';
  import { helperIds as scheduleHelpers } from '../lib/climate-schedule.js';
  // Thermostats that already have the schedule helper from docs/climate-schedule.yaml.
  function autofill() {
    const entities = [...states.keys()].filter((id) => id.startsWith('climate.') && states.has(scheduleHelpers(id).schedule)).sort();
    return entities.length ? { entities } : {};
  }
  export const meta = {
    type: 'climate-schedule', name: 'Climate schedule', icon: 'mdi:calendar-clock', category: 'Controls',
    size: { w: 460, h: 600 }, tap: 'none', hold: 'none',
    defaults: { title: 'Climate schedule', hour12: true, entities: [] },
    autofill,
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'name', label: 'Name (only when one thermostat is listed)', type: 'text' },
      { key: 'hour12', label: '12-hour clock', type: 'bool' },
      {
        key: 'entities', label: 'Thermostats', type: 'entities', domain: 'climate',
        hint: 'One tab each. Each one needs the helpers from the climate schedule package, named from its entity id.',
      },
    ],
  };
</script>

<script>
  // One or more thermostats (tabs): a picture of today, and up to eight times
  // with days, mode and temperature. Modes and the temperature range come from
  // the climate entity. Edits are saved to its text helper; the climate schedule
  // package applies them on the minute, and again when the schedule is switched on.
  // Handy as a pop-up on a thermostat card (hold action → pop-up).
  import Icon from '../components/Icon.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { t, ent } from '../lib/tpl.js';
  import { callService, toast } from '../lib/ha.svelte.js';
  import { clock } from '../lib/clock.svelte.js';
  import { stateWord } from '../lib/i18n.svelte.js';
  import { name } from '../lib/entity.js';
  import {
    APPLY_SCRIPT, DAY_LETTERS, DAY_NAMES, GRACE_MS, MAX_LEN, MAX_SLOTS, MODE_INFO,
    fmtNum, fmtWhen, helperIds, modesFor, nextAfter, normalizeSlot,
    parseSchedule, scheduledAt, serializeSchedule, slotText, sortSlots, starterSlots,
    tempBounds, tempKind, tempMatches, timeline, differs,
  } from '../lib/climate-schedule.js';

  let { props } = $props();

  const pad = (n) => String(n).padStart(2, '0');
  const pretty = (entityId) => (entityId.split('.')[1] || entityId).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const modeLabel = (m) => stateWord('climate', null, m) || MODE_INFO[m]?.label || String(m).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const modeIcon = (m) => MODE_INFO[m]?.icon || 'mdi:circle-medium';

  const ids = $derived.by(() => {
    const seen = new Set();
    const out = [];
    for (const raw of props.entities || []) {
      const id = String(t(raw) || '').trim();
      if (!id.startsWith('climate.') || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  });
  let sel = $state(0);
  const id = $derived(ids[Math.min(sel, Math.max(ids.length - 1, 0))] || '');
  const help = $derived(helperIds(id));
  const tabName = (entityId) => (ids.length === 1 && t(props.name)) || name(ent(entityId)) || pretty(entityId);
  const scheduleEnt = $derived(help.schedule ? ent(help.schedule) : undefined);
  const enabledEnt = $derived(help.enabled ? ent(help.enabled) : undefined);
  const enabled = $derived(enabledEnt?.state === 'on');
  const clim = $derived(ent(id));
  const attrs = $derived(clim?.attributes || {});
  const bounds = $derived(tempBounds(attrs));
  const climOk = $derived(!!clim && !/^(unavailable|unknown)$/.test(clim.state));
  const scriptEnt = $derived(ent(APPLY_SCRIPT));
  const hasScript = $derived(!!scriptEnt && scriptEnt.state !== 'unavailable');

  const now = $derived(new Date(clock.now));
  const hour12 = $derived(props.hour12 !== false);
  const modeList = $derived(modesFor(attrs));

  // What's saved, plus edits that are still on their way to the helper.
  let local = $state({});
  const ver = {}, timers = {}, pending = {};
  const slots = $derived.by(() => {
    if (!id) return [];
    return local[id] ?? parseSchedule(scheduleEnt?.state ?? '');
  });
  function save(entityId, v) {
    pending[entityId] = false;
    const target = helperIds(entityId).schedule;
    const text = serializeSchedule(local[entityId] || []);
    if (text.length > MAX_LEN) {
      toast('That schedule is too long to save — remove a time');
      local[entityId] = undefined;
      return;
    }
    if (!target || !ent(target)) {
      toast('Add a text helper for this schedule first');
      return;
    }
    callService('input_text', 'set_value', { value: text }, { entity_id: target })
      .finally(() => setTimeout(() => { if (ver[entityId] === v) local[entityId] = undefined; }, 1500));
  }
  function commit(entityId, next) {
    if (!entityId) return;
    local[entityId] = next;
    const v = (ver[entityId] = (ver[entityId] || 0) + 1);
    pending[entityId] = true;
    clearTimeout(timers[entityId]);
    timers[entityId] = setTimeout(() => save(entityId, v), 600);
  }
  // Closing the pop-up right after an edit must not lose it.
  $effect(() => () => {
    for (const entityId of Object.keys(pending)) {
      if (!pending[entityId]) continue;
      clearTimeout(timers[entityId]);
      save(entityId, ver[entityId]);
    }
  });

  function edit(i, patch) {
    const next = slots.map((s, j) => {
      if (j !== i) return s;
      const merged = { ...s, ...patch };
      if (patch.mode && tempKind(patch.mode, attrs) !== 'range') delete merged.tempHigh;
      return normalizeSlot(merged, attrs);
    });
    commit(id, patch.t ? sortSlots(next) : next);
  }
  const bump = (i, dir, which) => edit(i, which === 'high'
    ? { tempHigh: Number(slots[i].tempHigh) + dir * bounds.step }
    : { temp: Number(slots[i].temp) + dir * bounds.step });
  function toggleDay(i, k) {
    const days = slots[i].days.map((v, j) => (j === k ? !v : v));
    if (days.some(Boolean)) edit(i, { days });
  }
  const remove = (i) => commit(id, slots.filter((_, j) => j !== i));
  const canAdd = $derived(slots.length < MAX_SLOTS);
  function pickMode() {
    const curMode = clim?.state;
    if (curMode && modeList.includes(curMode) && curMode !== 'off' && curMode !== 'unavailable' && curMode !== 'unknown') return curMode;
    return modeList.find((m) => m !== 'off') || 'off';
  }
  function add() {
    const last = slots[slots.length - 1];
    const m = Math.min(23 * 60 + 30, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30);
    const mode = last?.mode && modeList.includes(last.mode) ? last.mode : pickMode();
    commit(id, sortSlots([...slots, normalizeSlot({
      t: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`,
      days: Array(7).fill(true),
      mode,
      temp: last?.temp,
      tempHigh: last?.tempHigh,
    }, attrs)]));
  }
  const useStarter = () => commit(id, starterSlots(pickMode(), attrs));

  const cur = $derived(scheduledAt(slots, now));
  const nxt = $derived(nextAfter(slots, now));
  // Give the unit a minute and a half after a time starts (or Resume) before calling
  // it changed by hand: mode and temperature are sent a few seconds apart.
  let resumedAt = $state({});
  const settling = $derived(!!cur && (now - cur.since < GRACE_MS || now - (resumedAt[id] || 0) < GRACE_MS));
  const override = $derived(enabled && !!cur && climOk && !settling && differs(cur.slot, clim));

  async function apply(slot) {
    const kind = tempKind(slot.mode, attrs);
    const ready = normalizeSlot(slot, attrs);
    if (hasScript) {
      const data = { entity_id: id, mode: ready.mode };
      if (kind !== 'none') data.temp = ready.temp;
      if (kind === 'range') data.temp_high = ready.tempHigh;
      return callService('script', APPLY_SCRIPT.split('.')[1], data);
    }
    // No package script: talk to the climate entity, mode first, and skip a call
    // that would not change anything.
    const target = { entity_id: id };
    if (!clim || clim.state !== ready.mode) await callService('climate', 'set_hvac_mode', { hvac_mode: ready.mode }, target);
    if (kind === 'none' || tempMatches(clim, ready)) return;
    const data = kind === 'range'
      ? { target_temp_low: ready.temp, target_temp_high: ready.tempHigh }
      : { temperature: ready.temp };
    return callService('climate', 'set_temperature', data, target);
  }
  function flip() {
    if (!enabledEnt) return;
    const turningOn = enabledEnt.state !== 'on';
    // The automation applies the current time when this switch turns on.
    // Hold the "changed by hand" warning back so that apply is not flagged.
    if (turningOn) resumedAt[id] = Date.now();
    callService('input_boolean', turningOn ? 'turn_on' : 'turn_off', {}, { entity_id: help.enabled });
  }
  function resume() {
    if (!cur?.slot) return;
    resumedAt[id] = Date.now();
    apply(cur.slot);
  }

  const described = (slot) => slotText(slot, { unit: bounds.unit, kind: tempKind(slot.mode, attrs), label: modeLabel(slot.mode) });
  const statusLine = $derived.by(() => {
    if (!slots.length) return 'Add a time to get started';
    const next = nxt ? `${described(nxt.slot)} · ${fmtWhen(nxt.when, now, hour12)}` : '';
    if (!enabled) return next ? `Paused · next would be ${next}` : 'Paused';
    if (override) return `Changed by hand · schedule says ${described(cur.slot)}`;
    return next ? `Next: ${next}` : 'No upcoming changes';
  });

  const segs = $derived(timeline(slots, now));
  const nowPct = $derived(((now.getHours() * 60 + now.getMinutes()) / 1440) * 100);
  const ticks = $derived([0, 6, 12, 18].map((h) => ({
    at: (h / 24) * 100,
    label: hour12 ? (h === 0 ? '12a' : h === 12 ? '12p' : `${h % 12}${h < 12 ? 'a' : 'p'}`) : String(h),
  })));
  const segText = (slot, len) => {
    if (!slot) return '';
    const kind = tempKind(slot.mode, attrs);
    if (kind === 'none') return len >= 180 ? modeLabel(slot.mode) : '';
    if (kind === 'range') return len >= 220 ? `${fmtNum(slot.temp)}–${fmtNum(slot.tempHigh)}` : '';
    return len >= 150 ? `${fmtNum(slot.temp)}°` : '';
  };
</script>

<div class="cs">
  <div class="head">
    <span class="ic"><Icon icon="mdi:calendar-clock" size="1.2em" /></span>
    <span class="title">{t(props.title) || 'Climate schedule'}</span>
  </div>

  {#if !ids.length}
    <div class="hint">Pick the thermostats in this card's settings.</div>
  {:else}
    {#if ids.length > 1}
      <div class="tabs" role="tablist" data-stop>
        {#each ids as entityId, i (entityId)}
          <button role="tab" aria-selected={entityId === id} class:on={entityId === id} onclick={() => (sel = i)}>
            <span class="dot" class:live={ent(helperIds(entityId).enabled)?.state === 'on'}></span>{tabName(entityId)}
          </button>
        {/each}
      </div>
    {/if}

    {#if !scheduleEnt}
      <div class="hint">
        Add the climate schedule package so {tabName(id)} has a text helper
        ({help.schedule}) and a switch ({help.enabled}).
      </div>
    {:else}
      <div class="status" class:paused={!enabled} class:warn={override}>
        <div class="st">
          <b>{enabled ? 'Schedule on' : 'Schedule paused'}</b>
          <span>{statusLine}</span>
        </div>
        {#if override}<button class="resume" data-stop onclick={resume}>Resume</button>{/if}
        {#if enabledEnt}<Toggle on={enabled} onclick={flip} color="var(--accent)" />{/if}
      </div>
      {#if !enabledEnt}<div class="hint">Add the on / off switch ({help.enabled}) so this schedule can run.</div>{/if}
      {#if !clim || !(attrs.hvac_modes || []).length}<div class="hint">This thermostat isn't reporting its modes yet, so Off, Cool and Heat are shown until it does.</div>{/if}

      <div class="tl" role="img" aria-label="Today's schedule">
        <div class="barwrap">
          <div class="bar">
            {#each segs as g}
              {@const len = g.to - g.from}
              {@const mode = g.slot?.mode || 'none'}
              <div class="seg {mode}" style="width:{len / 14.4}%">{segText(g.slot, len)}</div>
            {/each}
          </div>
          <i class="now" style="left:{nowPct}%"></i>
        </div>
        <div class="ticks">{#each ticks as tk}<span style="left:{tk.at}%">{tk.label}</span>{/each}</div>
      </div>

      <div class="list" data-stop>
        {#if !slots.length}
          <div class="empty">
            <Icon icon="mdi:calendar-blank-outline" size="2em" />
            <div>No times yet</div>
            <div class="row">
              <button class="soft" onclick={useStarter}>Start from a template</button>
              <button class="soft" onclick={add}>Add a time</button>
            </div>
          </div>
        {/if}
        {#each slots as s, i (s.t + s.mode + i)}
          {@const kind = tempKind(s.mode, attrs)}
          <div class="slot" style="--mc:var(--m-{s.mode}, #7aa2ff)">
            <div class="l1">
              <input type="time" value={s.t} aria-label="Start time" data-stop
                onchange={(e) => e.currentTarget.value && edit(i, { t: e.currentTarget.value })} />
              <div class="days" role="group" aria-label="Days">
                {#each DAY_LETTERS as d, k}
                  <button class="day" class:on={s.days[k]} aria-pressed={s.days[k]} aria-label={DAY_NAMES[k]} onclick={() => toggleDay(i, k)}>{d}</button>
                {/each}
              </div>
            </div>
            <div class="l2">
              <div class="modes" role="group" aria-label="Mode">
                {#each modesFor(attrs, s.mode) as m}
                  <button class="md" class:on={s.mode === m} style="--mc:var(--m-{m}, #7aa2ff)" aria-pressed={s.mode === m} onclick={() => edit(i, { mode: m })}>
                    <Icon icon={modeIcon(m)} size="1.05em" /><span>{modeLabel(m)}</span>
                  </button>
                {/each}
              </div>
              {#if kind === 'range'}
                <div class="temps">
                  <div class="step"><span class="k">Low</span><button onclick={() => bump(i, -1, 'low')} aria-label="Lower low temperature">−</button><b>{fmtNum(s.temp)}°</b><button onclick={() => bump(i, 1, 'low')} aria-label="Raise low temperature">+</button></div>
                  <div class="step"><span class="k">High</span><button onclick={() => bump(i, -1, 'high')} aria-label="Lower high temperature">−</button><b>{fmtNum(s.tempHigh)}°</b><button onclick={() => bump(i, 1, 'high')} aria-label="Raise high temperature">+</button></div>
                </div>
              {:else if kind === 'single'}
                <div class="step">
                  <button onclick={() => bump(i, -1, 'low')} aria-label="Lower">−</button><b>{fmtNum(s.temp)}°</b><button onclick={() => bump(i, 1, 'low')} aria-label="Raise">+</button>
                </div>
              {:else}
                <div class="step idle">{modeLabel(s.mode)}</div>
              {/if}
              <button class="del" onclick={() => remove(i)} aria-label="Delete this time"><Icon icon="mdi:trash-can-outline" size="1.1em" /></button>
            </div>
          </div>
        {/each}
        {#if slots.length}
          <button class="add" onclick={add} disabled={!canAdd}>{canAdd ? '+ Add a time' : `Up to ${MAX_SLOTS} times`}</button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .cs {
    --m-cool: #4fb4ff; --m-heat: #ff8a4c; --m-heat_cool: #b48cff; --m-auto: #5bd88f;
    --m-dry: #ffc861; --m-fan_only: #5bd88f; --m-off: #8a94a8;
    height: 100%; display: flex; flex-direction: column; gap: 12px; container-type: inline-size;
  }
  .head { display: flex; align-items: center; gap: 8px; }
  .ic { display: grid; place-items: center; color: var(--accent); }
  .title { font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { color: var(--muted); font-size: .85em; line-height: 1.35; }
  button { font: inherit; color: inherit; border: 0; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }

  .tabs { display: flex; gap: 6px; padding: 4px; border-radius: 14px; background: rgba(255,255,255,.06); overflow-x: auto; }
  .tabs button { flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 10px; border-radius: 10px; background: transparent; color: var(--muted); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tabs button.on { background: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--text, #fff); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,.22); flex: none; }
  .dot.live { background: #5bd88f; box-shadow: 0 0 8px #5bd88f88; }

  .status { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(255,255,255,.06); }
  .status.warn { background: rgba(255,200,97,.14); }
  .st { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .st b { font-weight: 600; }
  .st span { color: var(--muted); font-size: .85em; }
  .status.paused .st b { color: var(--muted); }
  .status.warn .st span { color: #ffc861; }
  .resume { padding: 8px 14px; border-radius: 12px; background: #ffc861; color: #1d1608; font-weight: 600; flex: none; }

  .tl { flex: none; }
  .barwrap { position: relative; }
  .bar { display: flex; height: 34px; border-radius: 10px; overflow: hidden; background: rgba(255,255,255,.05); }
  .seg { display: grid; place-items: center; font-size: .75em; font-weight: 600; overflow: hidden; white-space: nowrap; box-sizing: border-box; border-right: 1px solid rgba(0,0,0,.25); background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .seg:last-child { border-right: 0; }
  .seg.cool { background: color-mix(in srgb, var(--m-cool) 55%, transparent); }
  .seg.heat { background: color-mix(in srgb, var(--m-heat) 60%, transparent); }
  .seg.heat_cool { background: color-mix(in srgb, var(--m-heat_cool) 55%, transparent); }
  .seg.auto { background: color-mix(in srgb, var(--m-auto) 45%, transparent); }
  .seg.dry { background: color-mix(in srgb, var(--m-dry) 50%, transparent); }
  .seg.fan_only { background: color-mix(in srgb, var(--m-fan_only) 40%, transparent); }
  .seg.off { background: rgba(255,255,255,.1); color: var(--muted); }
  .seg.none { background: repeating-linear-gradient(135deg, rgba(255,255,255,.04) 0 6px, transparent 6px 12px); }
  .now { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; background: #fff; border-radius: 1px; box-shadow: 0 0 6px rgba(255,255,255,.7); pointer-events: none; }
  .ticks { position: relative; height: 1.3em; margin-top: 4px; color: var(--muted); font-size: .72em; }
  .ticks span { position: absolute; transform: translateX(-50%); }
  .ticks span:first-child { transform: none; }

  .list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
  .slot { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 16px; background: rgba(255,255,255,.06); border-left: 3px solid var(--mc); }
  .l1, .l2 { display: flex; align-items: center; gap: 8px; }
  .l1 { justify-content: space-between; flex-wrap: wrap; }
  .l2 { flex-wrap: wrap; }
  input[type='time'] { color-scheme: dark; background: rgba(255,255,255,.09); color: inherit; border: 0; border-radius: 12px; padding: 7px 10px; font: inherit; font-size: 1.05em; font-weight: 600; font-variant-numeric: tabular-nums; flex: none; }
  .days { display: flex; gap: 4px; }
  .day { width: 2.1em; height: 2.1em; border-radius: 50%; background: rgba(255,255,255,.07); color: var(--muted); font-size: .8em; font-weight: 600; padding: 0; }
  .day.on { background: color-mix(in srgb, var(--mc) 70%, transparent); color: #fff; }
  .modes { display: flex; gap: 4px; flex: 1; min-width: 0; flex-wrap: wrap; }
  .md { flex: 1; min-width: 2.4em; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 8px 6px; border-radius: 11px; background: rgba(255,255,255,.07); color: var(--muted); font-size: .85em; font-weight: 600; }
  .md.on { color: #fff; background: color-mix(in srgb, var(--mc) 65%, transparent); }
  .temps { display: flex; gap: 6px; flex: none; }
  .step { display: inline-flex; align-items: center; border-radius: 12px; background: rgba(255,255,255,.07); flex: none; }
  .step button { width: 2.2em; height: 2.2em; background: transparent; font-size: 1.1em; border-radius: 12px; }
  .step b { min-width: 2.6em; text-align: center; font-variant-numeric: tabular-nums; }
  .step .k { padding-left: 8px; color: var(--muted); font-size: .72em; font-weight: 600; }
  .step.idle { padding: 0 14px; height: 2.2em; color: var(--muted); font-size: .85em; }
  .del { flex: none; width: 2.2em; height: 2.2em; border-radius: 12px; background: rgba(255,255,255,.05); color: var(--muted); display: grid; place-items: center; padding: 0; margin-left: auto; }
  .add { padding: 12px; border-radius: 14px; background: transparent; border: 1.5px dashed rgba(255,255,255,.2); color: var(--muted); font-weight: 600; flex: none; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 8px; color: var(--muted); text-align: center; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 4px; }
  .soft { padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--text, #fff); font-weight: 600; }

  /* Phones: the days get a line of their own; mode buttons keep the icon. */
  @container (max-width: 440px) {
    .days { flex: 1 1 100%; justify-content: space-between; }
    .day { width: 2.2em; height: 2.2em; }
    .md span { display: none; }
    .md { padding: 8px 0; }
    .modes { flex: 1 1 140px; }
    .step button { width: 2em; }
    .step b { min-width: 2.2em; }
  }
</style>
