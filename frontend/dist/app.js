// Habit Calendar frontend. All data lives in the Go backend (SQLite); this file
// keeps an in-memory copy for rendering and writes every change straight back.

const $ = s => document.querySelector(s);
let api = null; // window.go.main.App, set in boot()
const COLORS = ['teal', 'amber', 'blue', 'coral', 'magenta', 'moss'];

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fmt = o => new Intl.DateTimeFormat(undefined, o);
const fMonth = fmt({ month: 'long' }), fMonthShort = fmt({ month: 'short' });
const fWeekday = fmt({ weekday: 'long' }), fDayMonth = fmt({ day: 'numeric', month: 'long' });
const fShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const fLong = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

let TODAY, TODAY_KEY;
// Returns true when the date has rolled over since the last check.
function syncToday() {
  const n = new Date();
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  if (keyOf(t) === TODAY_KEY) return false;
  TODAY = t; TODAY_KEY = keyOf(t);
  return true;
}
syncToday();

/* ---------- state ---------- */
const state = { habits: [], entries: {}, notes: {} };
const ui = {
  month: new Date(TODAY.getFullYear(), TODAY.getMonth(), 1),
  focus: TODAY_KEY,      // roving focus in the grid
  selected: TODAY_KEY,   // day shown in the day panel
  panel: null,           // null | 'habits' | 'day' | 'insights'
  adding: false,
  insView: 'year',
  year: TODAY.getFullYear(),
  filter: 'all',
};

const errText = err => (err && err.message) || String(err);

async function loadAll() {
  const [habits, range] = await Promise.all([api.ListHabits(), api.GetRange('', '')]);
  state.habits = habits || [];
  state.entries = (range && range.entries) || {};
  state.notes = (range && range.notes) || {};
}

// After a failed write, show why and fall back to what's actually stored.
async function recover(what, err) {
  toast(`Couldn't save ${what}: ${errText(err)}`);
  try { await loadAll(); } catch (e) { /* keep local copy */ }
  render();
}

/* ---------- habit logic ---------- */
const colorVar = h => `var(--h-${h.color})`;
const stepOf = h => h.kind === 'count' ? (h.target >= 20 ? 5 : 1) : 1;
const valOf = (h, k) => (state.entries[k] || {})[h.id] || 0;
const met = (h, k) => h.kind === 'bool' ? !!valOf(h, k) : valOf(h, k) >= h.target;
const ratio = (h, k) => h.kind === 'bool' ? (valOf(h, k) ? 1 : 0) : Math.min(1, valOf(h, k) / h.target);
const unitFor = (n, u) => {
  if (n !== 1 || !u) return u;
  if (/(ss|sh|ch|x)es$/.test(u)) return u.slice(0, -2);
  if (/s$/.test(u) && !/ss$/.test(u)) return u.slice(0, -1);
  return u;
};
const withUnit = (n, u) => u ? `${n} ${u}` : `${n}`;
const metaOf = h => h.kind === 'count' ? `${withUnit(h.target, h.unit)} a day` : 'Every day';
// A habit counts from the day it was added, or from its earliest logged day
// if older days were backfilled. Recomputed on every render.
let since = {};
function computeSince() {
  since = {};
  for (const h of state.habits) since[h.id] = h.createdOn && h.createdOn < TODAY_KEY ? h.createdOn : TODAY_KEY;
  for (const k in state.entries) {
    for (const id in state.entries[k]) if (since[id] && k < since[id]) since[id] = k;
  }
}
const activeOn = (h, k) => k >= since[h.id];
const activeHabits = k => state.habits.filter(h => activeOn(h, k));
const doneCount = k => activeHabits(k).filter(h => met(h, k)).length;

// Earliest day anything was tracked or noted.
function trackStart() {
  let min = TODAY_KEY;
  for (const id in since) if (since[id] < min) min = since[id];
  for (const k in state.notes) if (k < min) min = k;
  return min;
}
function currentStreak(h) {
  let d = TODAY;
  if (!met(h, keyOf(d))) d = addDays(d, -1);
  let n = 0;
  while (met(h, keyOf(d))) { n++; d = addDays(d, -1); }
  return n;
}
function bestStreak(h) {
  let best = 0, run = 0;
  for (let d = parseKey(since[h.id]); keyOf(d) <= TODAY_KEY; d = addDays(d, 1)) {
    if (met(h, keyOf(d))) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}

function setEntry(k, h, v) {
  if (k > TODAY_KEY) return;
  const day = state.entries[k] || (state.entries[k] = {});
  if (v > 0) day[h.id] = h.kind === 'bool' ? 1 : v; else delete day[h.id];
  if (!Object.keys(day).length) delete state.entries[k];
  render();
  api.SetEntry(k, h.id, v).catch(err => recover(h.name, err));
}

/* ---------- notes: saved shortly after typing stops ---------- */
const pendingNotes = new Map();
let noteTimer;
function queueNote(k, body) {
  if (body.trim()) state.notes[k] = body; else delete state.notes[k];
  pendingNotes.set(k, body);
  $('#note-status').textContent = 'Saving…';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNotes, 400);
}
async function flushNotes() {
  clearTimeout(noteTimer);
  const items = [...pendingNotes];
  pendingNotes.clear();
  for (const [k, body] of items) {
    try {
      await api.SetNote(k, body);
      if (ui.panel === 'day' && ui.selected === k && !pendingNotes.has(k)) $('#note-status').textContent = 'Saved';
    } catch (err) {
      if (ui.panel === 'day' && ui.selected === k) $('#note-status').textContent = 'Not saved';
      toast(`Couldn't save the note: ${errText(err)}`);
    }
  }
}

/* ---------- icons ---------- */
const ICON = {
  flame: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6.2.6c.4 1.9 3.3 3.2 3.3 6.3A3.5 3.5 0 0 1 2.5 7.1c0-1.4.8-2.4 1.6-3 0 1 .4 1.8 1.1 2.1C4.9 4.3 5.3 2.3 6.2.6Z"/></svg>',
  check: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.5-5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  prev: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  minus: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- calendar ---------- */
function dotHTML(h, k) {
  const c = colorVar(h);
  if (h.kind === 'bool') return `<i class="dot ${valOf(h, k) ? 'done' : 'miss'}" style="--c:${c}"></i>`;
  const r = ratio(h, k);
  if (r >= 1) return `<i class="dot done" style="--c:${c}"></i>`;
  if (r > 0) return `<i class="dot part" style="--c:${c};--p:${Math.round(r * 100)}%"></i>`;
  return `<i class="dot miss" style="--c:${c}"></i>`;
}
function renderCalendar() {
  const y = ui.month.getFullYear(), m = ui.month.getMonth();
  const first = new Date(y, m, 1), offset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -offset);
  const fd = parseKey(ui.focus);
  const tabKey = fd.getMonth() === m && fd.getFullYear() === y ? ui.focus : keyOf(first);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i), k = keyOf(d);
    const out = d.getMonth() !== m, future = k > TODAY_KEY;
    const active = future ? [] : activeHabits(k);
    const note = !out && state.notes[k];
    const label = `${fLong.format(d)}${k === TODAY_KEY ? ', today' : ''}${active.length ? `, ${doneCount(k)} of ${active.length} done` : ''}${state.notes[k] ? ', has a note' : ''}`;
    cells.push(`<button class="cell${out ? ' out' : ''}${future ? ' future' : ''}${k === TODAY_KEY ? ' today' : ''}${note ? ' note' : ''}"
      data-action="open-day" data-date="${k}" data-key="cell-${k}" tabindex="${k === tabKey ? 0 : -1}"
      aria-label="${label}" ${k === TODAY_KEY ? 'aria-current="date"' : ''}>
      <span class="num">${d.getDate()}</span>
      ${!out && active.length ? `<span class="dots" aria-hidden="true">${active.map(h => dotHTML(h, k)).join('')}</span>` : ''}
    </button>`);
  }
  $('#cal').innerHTML = cells.join('');
  $('#month-title').innerHTML = `${fMonth.format(first)} <span>${y}</span>`;

  const onToday = y === TODAY.getFullYear() && m === TODAY.getMonth();
  $('#today-btn').disabled = onToday || !!ui.panel;
  document.querySelectorAll('[data-action="prev"],[data-action="next"]').forEach(b => { b.disabled = !!ui.panel; });
  $('#cal-area').inert = !!ui.panel;
  $('#cal-area').setAttribute('aria-hidden', ui.panel ? 'true' : 'false');
}

/* ---------- panels ---------- */
function renderPanels() {
  ['habits', 'day', 'insights'].forEach(p => { $(`#${p}-panel`).hidden = ui.panel !== p; });
  $('#habits-btn').setAttribute('aria-expanded', ui.panel === 'habits');
  $('#insights-btn').setAttribute('aria-expanded', ui.panel === 'insights');
}

function renderHabits() {
  if (ui.panel !== 'habits') return;
  $('#habits-title').textContent = ui.adding ? 'New habit' : 'Habits';
  ['habits-view', 'add-btn', 'legend'].forEach(id => { $('#' + id).hidden = ui.adding; });
  $('#add-form').hidden = !ui.adding;
  if (ui.adding) return;

  $('#habits-empty').hidden = state.habits.length > 0;
  $('#legend').hidden = state.habits.length === 0;
  $('#habit-list').innerHTML = state.habits.map(h => {
    const s = currentStreak(h), v = valOf(h, TODAY_KEY), done = met(h, TODAY_KEY);
    let quick;
    if (h.kind === 'bool') {
      quick = `<button class="quick ${done ? 'done' : ''}" data-action="quick" data-hid="${h.id}" data-key="q-${h.id}"
        aria-pressed="${done}" aria-label="${esc(h.name)} today: ${done ? 'done. Mark as not done' : 'not done. Mark as done'}" title="Today">
        <svg viewBox="0 0 28 28" fill="none"><circle class="q-track" cx="14" cy="14" r="11" stroke-width="1.5"/>
        ${done ? '<circle class="q-disc" cx="14" cy="14" r="11.75"/><path class="q-check" d="M9.5 14.3l3 2.9 6-6.4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : ''}</svg></button>`;
    } else {
      const r = Math.min(1, v / h.target), C = 2 * Math.PI * 11, st = stepOf(h);
      quick = `<button class="quick ${done ? 'done' : ''}" data-action="quick" data-hid="${h.id}" data-key="q-${h.id}"
        aria-label="${esc(h.name)} today: ${v} of ${esc(withUnit(h.target, h.unit))}. Add ${esc(withUnit(st, unitFor(st, h.unit)))}" title="Today: add ${st}">
        <svg viewBox="0 0 28 28" fill="none"><circle class="q-track" cx="14" cy="14" r="11" stroke-width="2.5"/>
        ${done ? '<circle class="q-disc" cx="14" cy="14" r="12.25"/>' :
          `<circle class="q-fill" cx="14" cy="14" r="11" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(r * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 14 14)"/>`}</svg>
        <span class="q-val" aria-hidden="true">${v}</span></button>`;
    }
    return `<li class="habit" style="--c:${colorVar(h)}">
      <i class="swatch" aria-hidden="true"></i>
      <div class="habit-text"><span class="habit-name">${esc(h.name)}</span><span class="habit-meta">${esc(metaOf(h))}</span></div>
      <span class="streak ${s === 0 ? 'none' : ''} ${s >= 7 ? 'hot' : ''}" title="Current streak: ${s} day${s === 1 ? '' : 's'}">${ICON.flame}${s}d</span>
      ${quick}
    </li>`;
  }).join('');
}

let noteFor = null;
function renderDay() {
  if (ui.panel !== 'day') { noteFor = null; return; }
  const k = ui.selected, d = parseKey(k), future = k > TODAY_KEY;
  const diff = Math.round((d - TODAY) / 864e5);
  const rel = diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : diff === 1 ? 'Tomorrow' : fWeekday.format(d);
  $('#day-title').innerHTML = `<small>${rel}</small>${fDayMonth.format(d)}${d.getFullYear() !== TODAY.getFullYear() ? ' ' + d.getFullYear() : ''}`;
  const n = activeHabits(k).length, dc = doneCount(k);
  $('#day-sum').innerHTML = !state.habits.length ? 'No habits yet — add one from the Habits panel.'
    : future ? "This day hasn't happened yet — you can still leave a note."
    : !n ? 'Before any of these habits started. Marking one counts it from this day.'
    : `<b>${dc}</b> of <b>${n}</b> done${dc === n ? ' · perfect day' : ''}`;

  $('#day-habits').innerHTML = state.habits.map(h => {
    const v = valOf(h, k), on = met(h, k), c = colorVar(h);
    if (h.kind === 'bool') {
      return `<button class="hrow ${on ? 'on' : ''}" style="--c:${c}" data-action="toggle" data-hid="${h.id}" data-key="t-${h.id}" aria-pressed="${on}" ${future ? 'disabled' : ''}>
        <span class="check">${ICON.check}</span><span class="hname">${esc(h.name)}</span><span class="hstate">${on ? 'Done' : 'Not done'}</span></button>`;
    }
    const st = stepOf(h), pct = Math.min(100, Math.round(v / h.target * 100)), stepLabel = esc(withUnit(st, unitFor(st, h.unit)));
    return `<div class="hrow count ${future ? 'dis' : ''}" style="--c:${c}">
      <i class="swatch" aria-hidden="true"></i>
      <span class="hname">${esc(h.name)}</span>
      <span class="hval"><b>${v}</b>/${esc(withUnit(h.target, h.unit))}</span>
      <span class="stepper">
        <button data-action="dec" data-hid="${h.id}" data-key="dec-${h.id}" aria-label="Remove ${stepLabel} of ${esc(h.name)}" ${future || v <= 0 ? 'disabled' : ''}>${ICON.minus}</button>
        <button data-action="inc" data-hid="${h.id}" data-key="inc-${h.id}" aria-label="Add ${stepLabel} of ${esc(h.name)}" ${future ? 'disabled' : ''}>${ICON.plus}</button>
      </span>
      <div class="track" role="progressbar" aria-label="${esc(h.name)} progress" aria-valuemin="0" aria-valuemax="${h.target}" aria-valuenow="${Math.min(v, h.target)}"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join('');

  if (noteFor !== k) {
    noteFor = k;
    $('#day-note').value = state.notes[k] || '';
    $('#note-status').textContent = '';
  }
}

/* ---------- insights ---------- */
function renderYear() {
  const Y = ui.year;
  const hf = ui.filter === 'all' ? null : state.habits.find(h => h.id === ui.filter);
  const color = hf ? colorVar(hf) : 'var(--ink)';
  const rOf = k => {
    if (hf) return ratio(hf, k);
    const active = activeHabits(k);
    return active.reduce((a, h) => a + ratio(h, k), 0) / active.length;
  };
  const tracks = k => hf ? activeOn(hf, k) : activeHabits(k).length > 0;
  let tracked = 0, sum = 0;

  const months = [];
  for (let mo = 0; mo < 12; mo++) {
    const first = new Date(Y, mo, 1), off = (first.getDay() + 6) % 7, dim = new Date(Y, mo + 1, 0).getDate();
    const cells = Array.from({ length: off }, () => '<i class="yc blank"></i>');
    let ms = 0, mn = 0;
    for (let day = 1; day <= dim; day++) {
      const d = new Date(Y, mo, day), k = keyOf(d), today = k === TODAY_KEY ? ' is-today' : '';
      if (k > TODAY_KEY || !tracks(k)) { cells.push(`<i class="yc nt${today}"></i>`); continue; }
      const r = rOf(k); ms += r; mn++;
      const lvl = r <= 0 ? 0 : r < 0.34 ? 1 : r < 0.67 ? 2 : r < 1 ? 3 : 4;
      const tip = hf ? (hf.kind === 'count' ? `${valOf(hf, k)} / ${withUnit(hf.target, hf.unit)}` : (valOf(hf, k) ? 'Done' : 'Missed'))
                     : `${doneCount(k)} of ${activeHabits(k).length} done`;
      cells.push(`<i class="yc l${lvl}${today}" data-action="open-day" data-date="${k}" data-tip="${fShort.format(d)} · ${esc(tip)}"></i>`);
    }
    tracked += mn; sum += ms;
    months.push(`<div class="mo"><span class="mo-n">${fMonthShort.format(first)}<b>${mn ? Math.round(ms / mn * 100) + '%' : ''}</b></span><div class="mo-g">${cells.join('')}</div></div>`);
  }
  const chips = [`<button class="chip" data-action="filter" data-hid="all" data-key="f-all" aria-pressed="${!hf}">All</button>`]
    .concat(state.habits.map(h => `<button class="chip" data-action="filter" data-hid="${h.id}" data-key="f-${h.id}" aria-pressed="${ui.filter === h.id}" style="--c:${colorVar(h)}"><i class="swatch"></i>${esc(h.name)}</button>`)).join('');
  const sub = tracked ? `<b>${Y}</b> · <b>${tracked}</b> days tracked · <b>${Math.round(sum / tracked * 100)}%</b> ${hf ? 'hit' : 'average'}` : `<b>${Y}</b> · no history yet`;
  return `<p class="ins-sub">${sub}</p>
    ${state.habits.length ? `<div class="chips" role="group" aria-label="Show habit">${chips}</div>` : ''}
    <div class="yr" style="--c:${color}" aria-label="Completion by day for ${Y}">${months.join('')}</div>
    <div class="scale" aria-hidden="true">Less <i class="yc nt"></i><i class="yc l0"></i><i class="yc l1" style="--c:${color}"></i><i class="yc l2" style="--c:${color}"></i><i class="yc l3" style="--c:${color}"></i><i class="yc l4" style="--c:${color}"></i> More</div>`;
}

function renderStats() {
  if (!state.habits.length) return '<p class="ins-sub">Stats appear once you add a habit and start marking days.</p>';
  const N = 30;
  const keys = Array.from({ length: N }, (_, i) => keyOf(addDays(TODAY, i - N + 1)));
  const tracked = keys.filter(k => activeHabits(k).length > 0);
  let perfect = 0, checks = 0, possible = 0;
  tracked.forEach(k => {
    const n = activeHabits(k).length, dc = doneCount(k);
    checks += dc; possible += n;
    if (dc === n) perfect++;
  });
  const streaks = state.habits.map(h => ({ h, cur: currentStreak(h), best: bestStreak(h) }));
  const top = streaks.slice().sort((a, b) => b.cur - a.cur)[0];

  const items = streaks.map(({ h, cur, best }) => {
    const days = keys.filter(k => activeOn(h, k));
    const pct = days.length ? Math.round(days.filter(k => met(h, k)).length / days.length * 100) : 0;
    const bw = 150 / N;
    const bars = keys.map((k, i) => {
      const r = activeOn(h, k) ? ratio(h, k) : 0, x = i * bw + .5, w = bw - 1;
      const tip = `${fShort.format(parseKey(k))} · ${h.kind === 'count' ? `${valOf(h, k)} / ${withUnit(h.target, h.unit)}` : (valOf(h, k) ? 'Done' : 'Missed')}`;
      const mark = r > 0
        ? `<rect class="bar" x="${x.toFixed(2)}" y="${(20 - r * 19).toFixed(2)}" width="${w.toFixed(2)}" height="${(r * 19).toFixed(2)}" rx="1" ${met(h, k) ? '' : 'opacity=".5"'}/>`
        : `<rect class="zero" x="${x.toFixed(2)}" y="18.8" width="${w.toFixed(2)}" height="1.2" rx=".6"/>`;
      return `${mark}<rect class="hit" x="${(i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="20" data-tip="${esc(tip)}"/>`;
    }).join('');
    return `<li class="st-item" style="--c:${colorVar(h)}">
      <div class="st-top"><i class="swatch"></i><b>${esc(h.name)}</b><span class="st-streak">${cur}d <em>· best ${best}d</em></span></div>
      <div class="st-bot"><svg class="spark" viewBox="0 0 150 20" preserveAspectRatio="none" aria-label="${esc(h.name)}, last 30 days: ${pct}% of days">${bars}</svg><span class="st-pct">${pct}%</span></div>
    </li>`;
  }).join('');

  return `<p class="ins-sub">Last 30 days · ${fDayMonth.format(parseKey(keys[0]))} – ${fDayMonth.format(TODAY)}</p>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Perfect days</span><span class="kpi-val">${perfect}<small>/${tracked.length}</small></span></div>
      <div class="kpi"><span class="kpi-label">Check-ins</span><span class="kpi-val">${possible ? Math.round(checks / possible * 100) : 0}<small>%</small></span></div>
      <div class="kpi" title="${esc(top.h.name)}"><span class="kpi-label">Top streak</span><span class="kpi-val">${top.cur}<small>d ${esc(top.h.name)}</small></span></div>
    </div>
    <ul class="st-list">${items}</ul>
    <p class="st-foot">Streaks count back from today, or from yesterday if today isn't logged yet.</p>`;
}

function renderInsights() {
  if (ui.panel !== 'insights') return;
  document.querySelectorAll('[data-action="ins-view"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === ui.insView));
  const start = trackStart();
  const firstYear = parseKey(start).getFullYear();
  $('#ins-nav').innerHTML = ui.insView === 'year'
    ? `<button class="icon-btn" data-action="year-prev" data-key="y-prev" aria-label="Previous year" ${ui.year <= firstYear ? 'disabled' : ''}>${ICON.prev}</button>
       <button class="icon-btn" data-action="year-next" data-key="y-next" aria-label="Next year" ${ui.year >= TODAY.getFullYear() ? 'disabled' : ''}>${ICON.next}</button>`
    : '';
  $('#ins-body').innerHTML = ui.insView === 'stats' ? renderStats() : renderYear();
}

/* ---------- render ---------- */
function render() {
  const ak = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  computeSince();
  renderCalendar(); renderPanels(); renderHabits(); renderDay(); renderInsights();
  if (ak) {
    const el = document.querySelector(`[data-key="${ak}"]`);
    if (el && !el.disabled && !el.closest('[hidden]') && !el.closest('[inert]')) el.focus({ preventScroll: true });
  }
}
function showMonthOf(k) {
  const d = parseKey(k);
  if (d.getMonth() !== ui.month.getMonth() || d.getFullYear() !== ui.month.getFullYear()) ui.month = new Date(d.getFullYear(), d.getMonth(), 1);
}
function openPanel(p, focusSel) {
  ui.panel = p; ui.adding = false;
  render();
  const el = document.querySelector(focusSel);
  if (el) el.focus();
}
function closePanel() {
  if (pendingNotes.size) flushNotes();
  const was = ui.panel;
  ui.panel = null; ui.adding = false;
  render();
  const target = was === 'day' ? `[data-key="cell-${ui.focus}"]` : was === 'habits' ? '#habits-btn' : '#insights-btn';
  const el = document.querySelector(target);
  if (el) el.focus();
}
function openDay(k) {
  if (pendingNotes.size) flushNotes();
  ui.selected = k; ui.focus = k; showMonthOf(k);
  if (ui.panel === 'day') render();
  else openPanel('day', '[data-key="day-back"]');
}

/* ---------- theme ---------- */
const root = document.documentElement;
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const effectiveTheme = () => root.dataset.theme || (mq && mq.matches ? 'dark' : 'light');
function applyTheme(t) {
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = effectiveTheme() === 'dark', b = $('#theme-btn');
  b.innerHTML = dark ? ICON.sun : ICON.moon;
  b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  b.title = b.getAttribute('aria-label');
}
if (mq && mq.addEventListener) mq.addEventListener('change', () => applyTheme(root.dataset.theme));

/* ---------- toast & tooltip ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
const tip = $('#tip');
document.addEventListener('pointerover', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip; tip.hidden = false;
  const r = t.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = Math.min(window.innerWidth - w / 2 - 8, Math.max(w / 2 + 8, r.left + r.width / 2)) + 'px';
  tip.style.top = Math.max(tip.offsetHeight + 12, r.top) + 'px';
});
document.addEventListener('scroll', () => { tip.hidden = true; }, true);

/* ---------- events ---------- */
const habitById = id => state.habits.find(h => h.id === id);
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t || t.disabled) return;
  const a = t.dataset.action, h = t.dataset.hid ? habitById(t.dataset.hid) : null;
  switch (a) {
    case 'open-day': tip.hidden = true; openDay(t.dataset.date); break;
    case 'close': closePanel(); break;
    case 'panel':
      if (ui.panel === t.dataset.panel) closePanel();
      else {
        if (t.dataset.panel === 'insights') ui.year = TODAY.getFullYear();
        openPanel(t.dataset.panel, t.dataset.panel === 'habits' ? '[data-key="habits-back"]' : '[data-key="ins-back"]');
      }
      break;
    case 'prev': case 'next':
      ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() + (a === 'prev' ? -1 : 1), 1);
      render(); break;
    case 'today':
      ui.month = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1); ui.focus = TODAY_KEY;
      render(); break;
    case 'day-prev': case 'day-next':
      openDay(keyOf(addDays(parseKey(ui.selected), a === 'day-prev' ? -1 : 1))); break;
    case 'toggle': setEntry(ui.selected, h, valOf(h, ui.selected) ? 0 : 1); break;
    case 'inc': setEntry(ui.selected, h, valOf(h, ui.selected) + stepOf(h)); break;
    case 'dec': setEntry(ui.selected, h, Math.max(0, valOf(h, ui.selected) - stepOf(h))); break;
    case 'quick':
      if (h.kind === 'bool') setEntry(TODAY_KEY, h, valOf(h, TODAY_KEY) ? 0 : 1);
      else setEntry(TODAY_KEY, h, valOf(h, TODAY_KEY) + stepOf(h));
      break;
    case 'ins-view': ui.insView = t.dataset.view; render(); break;
    case 'year-prev': case 'year-next': ui.year += a === 'year-prev' ? -1 : 1; render(); break;
    case 'filter': ui.filter = t.dataset.hid; render(); break;
    case 'theme': {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      api.SetTheme(next).catch(err => toast(`Couldn't save the theme: ${errText(err)}`));
      break;
    }
    case 'add': startAdd(); break;
    case 'add-cancel': ui.adding = false; render(); $('#add-btn').focus(); break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !ui.panel) return;
  if (ui.adding) { ui.adding = false; render(); $('#add-btn').focus(); }
  else closePanel();
});

$('#cal').addEventListener('keydown', e => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const d = parseKey(cell.dataset.date);
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  let next;
  if (e.key in moves) next = addDays(d, moves[e.key]);
  else if (e.key === 'Home') next = addDays(d, -((d.getDay() + 6) % 7));
  else if (e.key === 'End') next = addDays(d, 6 - ((d.getDay() + 6) % 7));
  else if (e.key === 'PageUp' || e.key === 'PageDown') {
    const dir = e.key === 'PageUp' ? -1 : 1, y = d.getFullYear(), m = d.getMonth() + dir;
    next = new Date(y, m, Math.min(d.getDate(), new Date(y, m + 1, 0).getDate()));
  } else return;
  e.preventDefault();
  const k = keyOf(next);
  ui.focus = k; showMonthOf(k);
  render();
  const el = document.querySelector(`[data-key="cell-${k}"]`);
  if (el) el.focus();
});

$('#day-note').addEventListener('input', e => {
  queueNote(ui.selected, e.target.value);
  renderCalendar();
});
window.addEventListener('blur', () => { if (pendingNotes.size) flushNotes(); });

/* ---------- add habit ---------- */
$('#color-options').innerHTML = COLORS.map(c =>
  `<label title="${c[0].toUpperCase() + c.slice(1)}"><input type="radio" name="color" id="color-${c}" value="${c}"><span style="--c:var(--h-${c})"></span><span class="sr">${c}</span></label>`).join('');
function startAdd() {
  $('#add-form').reset();
  const used = new Set(state.habits.map(h => h.color));
  $('#color-' + (COLORS.find(c => !used.has(c)) || COLORS[0])).checked = true;
  $('#count-fields').hidden = true;
  $('#add-err').hidden = true;
  ui.adding = true;
  render();
  $('#habit-name').focus();
}
document.querySelectorAll('input[name="kind"]').forEach(r => r.addEventListener('change', () => {
  $('#count-fields').hidden = !$('#kind-count').checked;
}));
function formError(msg, focusSel) {
  const el = $('#add-err');
  el.textContent = msg; el.hidden = false;
  if (focusSel) $(focusSel).focus();
}
$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#habit-name').value.trim();
  if (!name) return formError('Give the habit a name.', '#habit-name');
  const kind = $('#kind-count').checked ? 'count' : 'bool';
  const target = kind === 'count' ? parseInt($('#habit-target').value, 10) : 1;
  if (kind === 'count' && !(target >= 1 && target <= 100000)) return formError('Set a daily target between 1 and 100000.', '#habit-target');
  const unit = kind === 'count' ? $('#habit-unit').value.trim() : '';
  const color = (document.querySelector('input[name="color"]:checked') || {}).value || COLORS[0];

  const submit = $('#add-submit');
  submit.disabled = true;
  try {
    const saved = await api.SaveHabit({ id: '', name, color, kind, target, unit });
    state.habits.push(saved);
    ui.adding = false;
    render();
    $('#add-btn').focus();
    toast(`Added ${saved.name}`);
  } catch (err) {
    formError(`Couldn't add the habit: ${errText(err)}`);
  } finally {
    submit.disabled = false;
  }
});

/* ---------- start ---------- */
function fatal(msg) {
  const el = $('#fatal');
  el.textContent = msg; el.hidden = false;
}

setInterval(() => { if (syncToday()) render(); }, 60000);
window.addEventListener('focus', () => { if (syncToday()) render(); });

// Wails injects window.go as the page starts; give it a moment in dev mode.
async function waitForBackend(ms = 3000) {
  const until = Date.now() + ms;
  while (!(window.go && window.go.main && window.go.main.App)) {
    if (Date.now() > until) return null;
    await new Promise(r => setTimeout(r, 50));
  }
  return window.go.main.App;
}

async function boot() {
  applyTheme('');
  api = await waitForBackend();
  if (!api) {
    fatal('Open Habit Calendar with `wails dev` or a built app — the Go backend isn\'t available in a plain browser tab.');
    return;
  }
  try {
    const [, theme] = await Promise.all([loadAll(), api.Theme()]);
    applyTheme(theme);
  } catch (err) {
    fatal(`Couldn't load your habits: ${errText(err)}`);
    return;
  }
  if (!state.habits.length) ui.panel = 'habits';
  render();
}
boot();
