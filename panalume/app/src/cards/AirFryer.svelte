<script module>
  import { find } from '../lib/octopus.js';
  // A smart plug's power sensor, not its energy / voltage / power-factor ones.
  const POWER = /^sensor\.(?!.*(factor|energy|total|today|yesterday|daily|monthly|cost|apparent|reactive))[a-z0-9_]*air_?fryer[a-z0-9_]*(power|watt|consumption)[a-z0-9_]*$/;
  export const meta = {
    type: 'airfryer', name: 'Air fryer', icon: 'mdi:fan', category: 'Controls',
    size: { w: 420, h: 200 }, tap: 'none', hold: 'none',
    defaults: { threshold: 50, grace: 3 },
    sections: [{ key: 'picture', label: 'Picture' }, { key: 'time', label: 'Cook time' }, { key: 'power', label: 'Power' }],
    autofill: () => ({ power: find(POWER) }),
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'power', label: 'Smart plug power sensor (W)', type: 'entity', domain: 'sensor', section: 'power' },
      { key: 'threshold', label: 'Cooking above (W): over the fan alone, under the heater', type: 'number' },
      { key: 'grace', label: 'Keep timing through no power for up to (min), e.g. basket out', type: 'number' },
    ],
  };
</script>

<script>
  // Air fryer: when it's cooking, paused (basket out) and finished, and how long
  // it has cooked, worked out from a smart plug's power sensor (lib/airfryer.js).
  // The cook is rebuilt from Home Assistant's history, so it survives reloads and
  // every screen shows the same time.
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { t, ent } from '../lib/tpl.js';
  import { conn, history } from '../lib/ha.svelte.js';
  import { clock } from '../lib/clock.svelte.js';
  import { hm, day } from '../lib/octopus.js';
  import { latestCook, watts, fmtDur } from '../lib/airfryer.js';
  let { props, w = 420, h = 200 } = $props();
  const show = (k) => !props.hide?.[k];

  const numOr = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  const on = $derived(Math.max(1, numOr(props.threshold, 50)));
  const graceMin = $derived(Math.max(0, numOr(props.grace, 3)));

  const HOURS = 24;
  const ms = (v) => (v == null ? NaN : typeof v === 'number' ? v * 1000 : Date.parse(v));
  const pe = $derived(ent(props.power));
  const powerId = $derived(String(t(props.power) || '').trim());
  const scale = $derived(/^kw$/i.test(pe?.attributes.unit_of_measurement || '') ? 1000 : 1);

  // Readings: Home Assistant's history, then every change seen since.
  let hist = $state.raw([]); // [[ms, state], …]
  let live = $state.raw([]);
  $effect(() => {
    const id = powerId;
    hist = [];
    live = [];
    if (!conn.connected || !id) return;
    let alive = true;
    history([id], HOURS)
      .then((res) => {
        if (!alive) return;
        const rows = (res[id] || []).map((p) => [(p.lu ?? p.lc) * 1000, p.s]).filter((p) => Number.isFinite(p[0]));
        hist = rows;
        const edge = rows.length ? rows[rows.length - 1][0] : 0;
        live = untrack(() => live).filter((p) => p[0] > edge);
      })
      .catch(() => {});
    return () => { alive = false; };
  });
  $effect(() => {
    const e = pe;
    const ts = ms(e?.last_changed);
    if (!e || !Number.isFinite(ts)) return;
    untrack(() => {
      const prev = live.length ? live[live.length - 1] : hist.length ? hist[hist.length - 1] : null;
      if (prev && prev[0] >= ts) return;
      live = [...(live.length >= 20000 ? live.slice(-15000) : live), [ts, e.state]];
    });
  });

  // Ticks every second only while a cook is under way (otherwise the shared 15 s clock is enough).
  let tick = $state(Date.now());
  const readings = $derived([...hist, ...live].map(([at, s]) => [at, watts(s, scale)]));
  const now = $derived(Math.max(tick, clock.now, readings.length ? readings[readings.length - 1][0] : 0));
  const cook = $derived(latestCook(readings, now, { on, grace: graceMin * 60e3 }));
  const going = $derived(cook.state === 'cooking' || cook.state === 'paused');
  $effect(() => {
    if (!going) return;
    const i = setInterval(() => (tick = Date.now()), 1000);
    return () => clearInterval(i);
  });

  const cooking = $derived(cook.state === 'cooking');
  const paused = $derived(cook.state === 'paused');
  const done = $derived(cook.state === 'done');
  const justDone = $derived(done && now - cook.end < 10 * 60e3);
  // The clock never stops for a pause: a cook is its whole span, start to finish.
  const elapsed = $derived(going ? now - cook.start : done ? cook.end - cook.start : 0);
  const pausedFor = $derived((cook.paused || 0) + (paused ? cook.gap : 0));
  const offline = $derived(!!pe && /^(unavailable|unknown)$/.test(String(pe.state)));
  const status = $derived(!pe ? 'No sensor' : cooking ? 'Cooking' : paused ? 'Paused' : justDone ? 'Finished' : offline ? 'Offline' : 'Idle');

  const drawn = $derived(Number(pe?.state) * scale);
  const when = (at) => (day(at, now) === 'Today' ? '' : day(at, now) + ' ') + hm(at);

  const R = 46, C = 2 * Math.PI * R;
  const size = $derived(Math.max(56, Math.min(h - 40, w * 0.4, 170)));
  // Short cards: one row of chips, and the time without the "since" line.
  const short = $derived(h < 150);
</script>

<div class="af" class:cooking class:paused class:done class:short style="--k:#ff7a45">
  {#if show('picture')}
    <div class="pic" style="width:{size}px;height:{size}px">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={R} class="track" />
        <circle cx="60" cy="60" r={R} class="arc" style="stroke-dasharray:{C};stroke-dashoffset:{going || done ? 0 : C}" />
        {#if done}
          <circle cx="60" cy="60" r="14" class="ok" /><path d="M53 60 l5 5 l9 -10" class="tick" />
        {:else}
          <g class="fan" class:spin={cooking}>
            {#each [0, 90, 180, 270] as a}<path d="M60 60 C60 44 74 38 80 46 C76 54 68 58 60 60Z" transform="rotate({a} 60 60)" class="blade" />{/each}
            <circle cx="60" cy="60" r="5" class="hub" />
          </g>
        {/if}
      </svg>
    </div>
  {/if}

  <div class="info">
    <div class="top">
      <span class="name"><Icon icon={meta.icon} size="1.1em" />{t(props.name) || meta.name}</span>
      <span class="chip" class:on={cooking} class:warn={paused} class:ok={justDone}>{status}</span>
    </div>

    {#if !pe}
      <div class="hint">Pick the smart plug's power sensor in the card's settings.</div>
    {:else}
      {#if show('time')}
        {#if going}
          <div class="left"><b>{fmtDur(elapsed)}</b>{#if !short || paused}<span>{paused ? `no power for ${fmtDur(cook.gap)}` : 'cooking'}{short ? '' : ` · since ${when(cook.start)}`}</span>{/if}</div>
        {:else if done}
          <div class="left" class:dim={!justDone}><b>{fmtDur(elapsed)}</b><span>{justDone ? 'cooked' : 'last cook'}{short ? '' : ` · finished ${when(cook.end)}`}</span></div>
        {:else}
          <div class="hint">{conn.connected ? `No cook in the last ${HOURS} hours` : 'Connecting…'}</div>
        {/if}
      {/if}

      {#if show('power')}
        <div class="chips">
          {#if going && Number.isFinite(drawn) && drawn > 0}<span><Icon icon="mdi:flash" size="1em" />{drawn >= 1000 ? (drawn / 1000).toFixed(1) + ' kW' : Math.round(drawn) + ' W'}</span>{/if}
          {#if (going || done) && pausedFor >= 30e3}<span><Icon icon="mdi:pause" size="1em" />{fmtDur(pausedFor)} paused</span>{/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .af { height: 100%; display: flex; gap: 16px; align-items: center; }
  .pic { flex: none; }
  .pic svg { width: 100%; height: 100%; display: block; }
  .track { fill: none; stroke: rgba(255,255,255,.08); stroke-width: 7; }
  .arc { fill: none; stroke: var(--k); stroke-width: 7; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 60px 60px; transition: stroke-dashoffset .6s, stroke .3s; opacity: .35; }
  .cooking .arc { opacity: 1; filter: drop-shadow(0 0 4px color-mix(in srgb, var(--k) 60%, transparent)); }
  .done .arc { stroke: #5bd88f; opacity: 1; }
  .blade { fill: rgba(255,255,255,.28); }
  .hub { fill: #4a5263; }
  .cooking .blade { fill: var(--k); }
  .paused .blade { fill: #ffc861; }
  .fan { transform-origin: 60px 60px; animation: spin .6s linear infinite; animation-play-state: paused; }
  .fan.spin { animation-play-state: running; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ok { fill: #5bd88f; }
  .tick { fill: none; stroke: #0b0f16; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .top { display: flex; align-items: center; gap: 8px; }
  .name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name :global(svg) { color: var(--k); flex: none; }
  .chip { flex: none; font-size: .75em; font-weight: 600; padding: 3px 9px; border-radius: 10px; background: rgba(255,255,255,.07); color: var(--muted); }
  .chip.on { background: color-mix(in srgb, var(--k) 20%, transparent); color: var(--k); }
  .chip.warn { background: rgba(255,200,97,.16); color: #ffc861; }
  .chip.ok { background: rgba(91,216,143,.16); color: #5bd88f; }
  .left { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .left b { font-size: 1.45em; font-weight: 600; letter-spacing: -.02em; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .left span { color: var(--muted); font-size: .85em; }
  .left.dim b { color: var(--muted); }
  .hint { color: var(--muted); font-size: .85em; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-left: -8px; } /* chip text lines up with the text above */
  .short { gap: 12px; }
  .short .info { gap: 3px; }
  .short .chips { max-height: calc(.9em + 8px); overflow: hidden; }
  .chips span { display: inline-flex; align-items: center; gap: 4px; font-size: .75em; padding: 3px 8px; border-radius: 9px; background: rgba(255,255,255,.06); }
</style>
