import { IfitClient, Mode } from './treadmill.js';
import { MODE_LABELS } from './protocol.js';
import { BluetoothTransport, bluetoothAvailable, isAppleMobile } from './bluetooth.js';
import { SimulatorTransport } from './simulator.js';
import { CODES, isValidCode } from './codes.js';
import { BREEDS, CatScene, DEFAULT_VIEW } from './cat.js';
import { DEFAULT_LEVELS, PRESETS, ProgramRunner, buildIntervals, formatClock, resolve, totalSeconds } from './programs.js';
import { Session, addToHistory } from './session.js';
import { beep, buzz, drawChart, profileSvg, setGauge, tweenNumber } from './hud.js';
import { HeartMonitor } from './heart.js';
import {
  FITNESS_LABELS, ZONE_DEFS, bmi, bmiLabel, bmr, buildReport, fitnessLevel, heartZones, isCompleteProfile,
  maxHeartRate, vo2maxFromProfile, zoneOf, zoneSpeeds,
} from './fitness.js';
import { renderReport, reportFiles } from './report.js';
import { HeartRunner, buildHeartProgram, heartPresets, targetLimits } from './hrcontrol.js';

const $ = (id) => document.getElementById(id);
const KM_PER_MILE = 1.609344;
const SEND_DELAY_MS = 450; // wait for the taps to stop before sending a new target
const HOLD_MS = 1800; // keep showing the requested target until the treadmill reports it

// ---------- settings ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`ctlx.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(`ctlx.${key}`);
      else localStorage.setItem(`ctlx.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};

const settings = {
  units: store.get('units', null), // null = follow the treadmill until the user picks
  demo: store.get('demo', false) || new URLSearchParams(location.search).has('demo'),
  showAll: store.get('showAll', false),
  sound: store.get('sound', true),
  cat: store.get('cat', 'tabby'), // a key of BREEDS, or 'off'
  catHolo: store.get('catHolo', false),
  levels: { ...DEFAULT_LEVELS, ...store.get('levels', {}) },
  custom: { warmupMin: 5, workSec: 60, restSec: 60, repeats: 6, cooldownMin: 3, workIncline: 0, ...store.get('custom', {}) },
  heartCustom: { target: null, minutes: 20, control: 'speed', ...store.get('heartCustom', {}) }, // target null = middle of the fat-burn zone
  traffic: false,
};

// ---------- state ----------

let client = null;
let lastDevice = null;
let uiState = 'disconnected'; // disconnected | busy | ready | monitor
let wakeLock = null;
let prevMode;
let runner = null; // active ProgramRunner
let runnerOffset = null; // workout seconds at which the program started
let selectedProgram = null;
let lastCountdown = 0;
let lastHeartAction = null; // what the heart-rate controller last reported, for one-off notices
let history = store.get('history', []);
let profile = store.get('profile', null); // sex, age, weight, height for zones and VO2 max
let reportPages = []; // canvases of the report on screen
let reportSummary = null;
const session = new Session();
const pending = { Kph: null, Incline: null };
const sendTimers = { Kph: null, Incline: null };
const holdUntil = { Kph: 0, Incline: 0 };
const logLines = [];
const cat = new CatScene($('catCanvas'));
const heart = new HeartMonitor();
{
  const view = store.get('view', null);
  if (view) cat.setView(view.yaw, view.pitch);
}

const imperial = () => (settings.units ?? 'metric') === 'imperial';
const toDisplaySpeed = (kph) => (imperial() ? kph / KM_PER_MILE : kph);
const fromDisplaySpeed = (v) => (imperial() ? v * KM_PER_MILE : v);
const speedUnit = () => (imperial() ? 'mph' : 'km/h');
const distUnit = () => (imperial() ? 'mi' : 'km');
const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const feedback = (freq, pattern = 12) => {
  if (!settings.sound) return;
  buzz(pattern);
  if (freq) beep(freq);
};

function limits() {
  const l = client?.info.limits ?? {};
  return {
    minKph: l.MinKph > 0 ? l.MinKph : 1,
    maxKph: l.MaxKph > 0 ? l.MaxKph : 16,
    minIncline: l.MinIncline ?? 0,
    maxIncline: l.MaxIncline > 0 ? l.MaxIncline : 12,
  };
}

const isMoving = (mode) => mode === Mode.ACTIVE || mode === Mode.WARMUP;

/** The Carbon TLX reports 0 for measured belt speed, so fall back to the set speed while running. */
function beltKph(v) {
  if (v.CurrentKph > 0) return v.CurrentKph;
  return isMoving(v.Mode) ? (v.Kph ?? 0) : 0;
}

/** Heart rate from the linked strap if there is one, else whatever the treadmill reports. */
const currentBpm = (v) => heart.bpm || v.Pulse?.pulse || 0;

/** Is there a pulse to steer a heart-rate program by? */
const hasPulse = () => heart.state === 'on' || currentBpm(client?.values ?? {}) > 0 || (settings.demo && uiState === 'ready');

function log(line) {
  const stamp = new Date().toTimeString().slice(0, 8);
  logLines.push(`${stamp} ${line}`);
  if (logLines.length > 300) logLines.shift();
  if ($('settings').open) $('log').textContent = logLines.join('\n');
}

// ---------- rendering ----------

function setState(state, text) {
  uiState = state;
  $('status').dataset.state = state;
  $('orbit').dataset.state = state;
  $('statusText').textContent = text;
  $('connectBtn').textContent = state === 'disconnected' ? 'Link' : state === 'busy' ? 'Cancel' : 'Unlink';
  renderControls();
}

function banner(text, isError = false) {
  const el = $('banner');
  el.hidden = !text;
  el.textContent = text ?? '';
  el.classList.toggle('error', isError);
  el.dataset.kind = text ? 'msg' : '';
}

function paceText(kph) {
  const speed = toDisplaySpeed(kph);
  return speed >= 0.5 ? formatClock(3600 / speed) : '--';
}

function renderValues() {
  const v = client?.values ?? {};
  const lim = limits();
  const now = Date.now();
  const mode = v.Mode;
  const kph = beltKph(v);

  tweenNumber($('speedNow'), toDisplaySpeed(kph), 1);
  tweenNumber($('inclineNow'), v.CurrentIncline ?? 0, 1);
  $('uSpeed').textContent = speedUnit();

  for (const [name, targetId, fmt] of [
    ['Kph', 'speedTarget', (x) => toDisplaySpeed(x).toFixed(1)],
    ['Incline', 'inclineTarget', (x) => x.toFixed(1)],
  ]) {
    if (pending[name] !== null && sendTimers[name] === null && now > holdUntil[name]) pending[name] = null;
    const el = $(targetId);
    el.textContent = fmt(pending[name] ?? v[name] ?? 0);
    el.parentElement.classList.toggle('pending', pending[name] !== null);
  }
  setGauge($('speedArc'), $('speedMarker'), kph, pending.Kph ?? v.Kph ?? 0, lim.maxKph);
  setGauge($('inclineArc'), $('inclineMarker'), v.CurrentIncline ?? 0, pending.Incline ?? v.Incline ?? 0, lim.maxIncline);
  markPresets('speedPresets', round1(toDisplaySpeed(pending.Kph ?? v.Kph ?? 0)), true);
  markPresets('inclinePresets', pending.Incline ?? v.Incline ?? 0, isMoving(mode) || pending.Incline !== null);

  $('mTime').textContent = formatClock(session.seconds);
  const km = session.metres / 1000;
  $('mDistance').textContent = (imperial() ? km / KM_PER_MILE : km).toFixed(2);
  $('uDistance').textContent = distUnit();
  // With a profile, calories come from the oxygen cost of the speed and incline at the user's weight.
  $('mCalories').textContent = Math.round(isCompleteProfile(profile) ? (session.o2PerKg * profile.weightKg * 5) / 1000 : session.kcal);
  renderHeart();
  $('mPace').textContent = paceText(kph);
  $('uPace').textContent = `Pace /${distUnit()}`;
  $('mAvg').textContent = toDisplaySpeed(session.avgKph).toFixed(1);
  $('uAvg').textContent = `Avg ${speedUnit()}`;
  $('mMax').textContent = toDisplaySpeed(session.maxKph).toFixed(1);
  $('uMax').textContent = `Max ${speedUnit()}`;
  $('mElev').textContent = Math.round(session.elevation);

  const stage = $('stage');
  stage.dataset.run = isMoving(mode) ? '1' : mode === Mode.PAUSE ? 'paused' : '0';
  $('modeTag').textContent = !client?.connected ? 'Standby' : (MODE_LABELS[mode] ?? 'Standby');
  $('paceTag').textContent = isMoving(mode) && kph >= 0.5 ? `${paceText(kph)} /${distUnit()}` : '';
  cat.setSpeed(kph);
  cat.setIncline(v.CurrentIncline ?? 0);

  if (client?.connected && mode !== undefined) {
    const prefix = uiState === 'monitor' ? 'Monitor' : client.transport.name;
    $('statusText').textContent = `${prefix} · ${MODE_LABELS[mode] ?? `mode ${mode}`}`;
    const el = $('banner');
    if (mode === Mode.MISSING_SAFETY_KEY) {
      banner('Safety key is not in place. Insert it on the treadmill to start.', true);
      el.dataset.kind = 'key';
    } else if (el.dataset.kind === 'key') banner(null);
  }

  drawChart($('chart'), session.samples.map((s) => [s.t, s.kph, s.incline, s.hr]), {
    maxKph: Math.max(session.maxKph, 8),
    maxIncline: lim.maxIncline,
    toSpeed: toDisplaySpeed,
  });
  renderProgram();
  renderControls();
}

function renderHeart() {
  const bpm = currentBpm(client?.values ?? {});
  const cell = $('pulseCell');
  $('mPulse').textContent = bpm || '--';
  cell.dataset.state = heart.state;
  cell.style.setProperty('--beat', bpm ? `${(60 / bpm).toFixed(2)}s` : '0s');
  const zone = bpm && isCompleteProfile(profile) ? ZONE_DEFS[zoneOf(heartZones(profile), bpm) - 1] : null;
  $('mPulse').style.color = zone ? zone.color : '';
  $('uPulse').textContent = zone
    ? `Z${zone.id} · ${zone.name}`
    : heart.state === 'on' ? 'Bpm · strap' : heart.state === 'off' ? (bpm ? 'Bpm' : 'Bpm · link') : 'Bpm · linking';
  const names = { off: 'Not linked', connecting: 'Linking…', reconnecting: 'Signal lost, reconnecting…' };
  $('heartStatus').textContent =
    heart.state === 'on' ? `${heart.name}${heart.battery !== null ? ` · battery ${heart.battery}%` : ''}` : names[heart.state];
  $('heartBtn').textContent = heart.state === 'off' ? 'Link' : 'Unlink';
}

async function linkHeart() {
  if (heart.state !== 'off') return;
  if (!HeartMonitor.available) {
    banner('This browser has no Web Bluetooth, so a strap cannot be linked.');
    return;
  }
  try {
    await heart.link();
    if (heart.state === 'on') {
      log(`heart strap linked: ${heart.name}`);
      feedback(880, 20);
    }
  } catch (err) {
    log(`heart strap failed: ${err.message}`);
    banner(`Could not link the heart rate strap: ${err.message}`, true);
  }
}

function markPresets(boxId, value, active) {
  for (const b of $(boxId).children) b.classList.toggle('on', active && value > 0 && Math.abs(Number(b.dataset.v) - value) < 0.05);
}

function renderControls() {
  const ready = uiState === 'ready';
  const mode = client?.values.Mode;
  const moving = isMoving(mode);
  for (const el of document.querySelectorAll('.step, .presets button')) el.disabled = !ready;
  const start = $('startBtn');
  start.disabled = !ready || mode === Mode.MISSING_SAFETY_KEY;
  start.dataset.kind = moving ? 'pause' : 'start';
  start.firstElementChild.textContent = moving ? 'Pause' : mode === Mode.PAUSE ? 'Resume' : 'Start';
  $('stopBtn').disabled = !ready || !(moving || mode === Mode.PAUSE);
  $('startProgramBtn').disabled =
    !ready || !selectedProgram || mode === Mode.MISSING_SAFETY_KEY || (!!selectedProgram.heart && !hasPulse());
}

function renderPresets() {
  const lim = limits();
  const fill = (boxId, values, label, onPick) => {
    $(boxId).replaceChildren(
      ...values.map((value) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label(value);
        b.dataset.v = value;
        b.addEventListener('click', () => {
          feedback(0);
          onPick(value);
        });
        return b;
      }),
    );
  };
  const speeds = (imperial() ? [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [3, 4, 6, 8, 10, 12, 14, 16, 18]).filter((s) => {
    const kph = fromDisplaySpeed(s);
    return kph >= lim.minKph - 0.01 && kph <= lim.maxKph + 0.05;
  });
  fill('speedPresets', speeds.slice(0, 8), String, (s) => setTarget('Kph', fromDisplaySpeed(s)));
  const inclines = [-3, 0, 1, 2, 4, 6, 8, 10, 12, 15].filter((i) => i >= lim.minIncline && i <= lim.maxIncline);
  fill('inclinePresets', inclines.slice(0, 8), (i) => `${i}%`, (i) => setTarget('Incline', i));
  renderControls();
}

// ---------- control ----------

function setTarget(name, value) {
  if (uiState !== 'ready') return;
  const lim = limits();
  pending[name] = name === 'Kph' ? clamp(value, lim.minKph, lim.maxKph) : clamp(value, lim.minIncline, lim.maxIncline);
  clearTimeout(sendTimers[name]);
  sendTimers[name] = setTimeout(() => sendTarget(name), SEND_DELAY_MS);
  runner?.manual?.(name, pending[name]); // a heart-rate program carries on from a change made by hand
  renderValues();
}

function nudge(name, direction) {
  const current = pending[name] ?? client?.values[name] ?? 0;
  if (name === 'Kph') setTarget('Kph', fromDisplaySpeed(round1(toDisplaySpeed(current)) + direction * 0.1));
  else setTarget('Incline', Math.round(current * 2) / 2 + direction * 0.5);
}

async function sendTarget(name) {
  sendTimers[name] = null;
  const value = pending[name];
  if (value === null || !client?.connected) return;
  holdUntil[name] = Date.now() + HOLD_MS;
  try {
    if (name === 'Kph') await client.setSpeed(Math.round(value * 100) / 100);
    else await client.setIncline(value);
    log(`set ${name} = ${value.toFixed(2)}`);
  } catch (err) {
    pending[name] = null;
    banner(`Could not set ${name === 'Kph' ? 'speed' : 'incline'}: ${err.message}`, true);
  }
}

function cancelPending() {
  for (const name of ['Kph', 'Incline']) {
    clearTimeout(sendTimers[name]);
    sendTimers[name] = null;
    pending[name] = null;
  }
}

async function modeCommand(label, action) {
  if (!client?.connected) return;
  try {
    await action();
    log(label);
    await client.refresh();
  } catch (err) {
    banner(`${label} failed: ${err.message}`, true);
  }
}

async function stopWorkout() {
  cancelPending();
  endProgram();
  await modeCommand('Stop', async () => {
    const ended = await client.stop();
    banner(ended ? null : 'Belt stopped. The treadmill kept the workout paused; it will return to idle by itself.');
  });
}

// Press and hold a +/- button to keep stepping.
function holdable(button, action) {
  let delay = null;
  let repeat = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
  };
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled) return;
    event.preventDefault();
    feedback(0, 8);
    action();
    delay = setTimeout(() => (repeat = setInterval(action, 130)), 450);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

// ---------- workout tracking ----------

function onValues() {
  const v = client?.values ?? {};
  const mode = v.Mode;
  const moving = isMoving(mode);
  const wasInWorkout = isMoving(prevMode) || prevMode === Mode.PAUSE;

  // A fresh start (not a resume) begins a new session.
  if (moving && !wasInWorkout) session.reset();
  session.update({
    seconds: v.CurrentTime ?? 0,
    metres: v.CurrentDistance ?? 0,
    kcal: v.CurrentCalories ?? 0,
    kph: beltKph(v),
    incline: v.CurrentIncline ?? 0,
    hr: currentBpm(v),
    running: moving,
  });

  if (runner) driveProgram(moving, prevMode === Mode.PAUSE && moving);

  // Back to idle/summary after running or pausing: the workout is over.
  if (wasInWorkout && (mode === Mode.IDLE || mode === Mode.SUMMARY)) finishWorkout();
  prevMode = mode;
  renderValues();
}

function finishWorkout() {
  endProgram();
  if (session.active && session.seconds >= 10) {
    const summary = session.summary();
    if (isCompleteProfile(profile)) {
      summary.report = buildReport(
        { seconds: session.seconds, o2PerKg: session.o2PerKg, hrSeconds: session.hrSeconds, samples: session.samples },
        profile,
      );
      if (summary.report.vo2Source === 'session') {
        store.set('vo2log', [...store.get('vo2log', []), { date: summary.date, value: summary.report.vo2max }].slice(-20));
      }
    }
    history = addToHistory(history, summary);
    store.set('history', history);
    showSummary(summary, 'Workout complete');
    feedback(660, [30, 60, 30]);
  }
  session.reset();
}

// ---------- programs ----------

function startProgram() {
  if (uiState !== 'ready' || !selectedProgram) return;
  if (selectedProgram.heart && !hasPulse()) return;
  runner = selectedProgram.heart
    ? new HeartRunner(selectedProgram, settings.levels, limits(), { maxHr: isCompleteProfile(profile) ? maxHeartRate(profile) : null })
    : new ProgramRunner(selectedProgram, settings.levels, limits());
  lastHeartAction = null;
  runnerOffset = null;
  lastCountdown = 0;
  $('programs').close();
  buildSegments();
  log(`program: ${selectedProgram.name}`);
  if (!isMoving(client.values.Mode)) modeCommand('Start', () => client.start());
  renderProgram();
}

function endProgram() {
  if (!runner) return;
  runner = null;
  runnerOffset = null;
  $('countdown').hidden = true;
  if ($('banner').dataset.kind === 'heart') banner(null);
  renderProgram();
}

async function applyStep(step) {
  // `quiet` marks a small automatic adjustment by a heart-rate program, not a new step.
  if (!step.quiet) cancelPending();
  log(`program ${step.quiet ? 'adjust' : 'step'}: ${step.label} ${step.kph} km/h, ${step.incline} %`);
  if (step.quiet) feedback(step.direction > 0 ? 700 : 500, 8);
  else feedback(988, [20, 40, 20]);
  try {
    if (!step.quiet || Math.abs((client.values.Kph ?? 0) - step.kph) > 0.01) await client.setSpeed(step.kph);
    if (Math.abs((client.values.Incline ?? 0) - step.incline) > 0.01) await client.setIncline(step.incline);
  } catch (err) {
    banner(`Program could not set the treadmill: ${err.message}`, true);
  }
}

function driveProgram(moving, resumed) {
  if (!moving) return;
  if (runnerOffset === null) runnerOffset = session.seconds;
  if (resumed) runner.resume?.();
  const state = runner.update(session.seconds - runnerOffset, { hr: currentBpm(client.values) });
  if (state.done) {
    if (state.finishedNow) {
      log('program finished');
      stopWorkout();
    }
    return;
  }
  if (state.apply) applyStep(state.apply);
  else if (resumed) applyStep(runner.current); // the belt restarts slow after a pause
  if (state.heart) heartNotice(state.heart.action);
  if (state.countdown !== lastCountdown) {
    lastCountdown = state.countdown;
    const el = $('countdown');
    if (state.countdown > 0 && state.next) {
      el.textContent = state.countdown;
      el.hidden = false;
      el.classList.remove('pop');
      void el.offsetWidth; // restart the animation
      el.classList.add('pop');
      feedback(state.countdown === 1 ? 740 : 520, 15);
    } else el.hidden = true;
  }
}

/** One-off warnings while a heart-rate program is steering. */
function heartNotice(action) {
  if (action === lastHeartAction) return;
  lastHeartAction = action;
  const el = $('banner');
  if (action === 'nosignal') {
    banner('No heart rate signal. Holding this pace; if it stays away the program eases back to a walk. Check the strap.', true);
    el.dataset.kind = 'heart';
    feedback(300, [60, 40, 60]);
  } else if (action === 'drop') {
    banner('Pulse well above the target: easing off.', true);
    el.dataset.kind = 'heart';
    feedback(300, [60, 40, 60]);
  } else if (el.dataset.kind === 'heart' && !['ease', 'high', 'down', 'bottom'].includes(action)) banner(null);
}

function heartStatusText(status, control) {
  const what = control === 'speed' ? 'speed' : 'incline';
  const bpm = status.bpm ? `${status.bpm} bpm · ` : '';
  switch (status.action) {
    case 'warmup':
      return `Then hold ${status.target} bpm`;
    case 'cooldown':
      return 'Cooling down';
    case 'nosignal':
      return 'No pulse · holding pace';
    case 'ease':
      return 'No pulse · easing off';
    case 'hold':
      return `${bpm}on target`;
    case 'low':
    case 'up':
      return `${bpm}raising ${what}`;
    case 'high':
    case 'down':
      return `${bpm}lowering ${what}`;
    case 'drop':
      return `${bpm}too high`;
    case 'top':
      return control === 'speed' ? `${bpm}at your Run speed` : `${bpm}at top incline`;
    case 'bottom':
      return `${bpm}at lowest ${what}`;
    default:
      return 'Reading pulse';
  }
}

function buildSegments() {
  $('progSegments').replaceChildren(
    ...runner.steps.map((s) => {
      const i = document.createElement('i');
      i.style.setProperty('--w', s.seconds);
      return i;
    }),
  );
}

function renderProgram() {
  const bar = $('programBar');
  bar.hidden = !runner;
  if (!runner) return;
  const elapsed = runnerOffset === null ? 0 : Math.max(0, session.seconds - runnerOffset);
  const index = Math.max(0, runner.index);
  const step = runner.steps[index];
  const next = runner.steps[index + 1];
  const into = clamp(elapsed - step.start, 0, step.seconds);
  $('progStep').textContent = step.label;
  $('progRemain').textContent = formatClock(step.seconds - into);
  if (runner.heart) {
    bar.dataset.heart = ['nosignal', 'ease', 'drop', 'top', 'bottom'].includes(runner.status.action) ? 'alert' : 'ok';
    $('progNext').textContent = heartStatusText(runner.status, runner.heart.control);
  } else {
    delete bar.dataset.heart;
    $('progNext').textContent = next
      ? `Next · ${next.label} · ${toDisplaySpeed(next.kph).toFixed(1)}${next.incline ? ` · ${next.incline}%` : ''}`
      : `Last step · ${formatClock(runner.total - elapsed)} left`;
  }
  [...$('progSegments').children].forEach((el, i) => {
    el.classList.toggle('done', i < index);
    el.classList.toggle('now', i === index);
    if (i === index) el.style.setProperty('--p', `${(into / step.seconds) * 100}%`);
  });
}

function renderProgramSheet() {
  const lim = limits();
  $('lvlUnit').textContent = speedUnit();
  for (const [id, key] of [['lvlWalk', 'walk'], ['lvlJog', 'jog'], ['lvlRun', 'run']]) {
    $(id).value = toDisplaySpeed(settings.levels[key]).toFixed(1);
  }
  for (const [id, key] of [['cWarm', 'warmupMin'], ['cWork', 'workSec'], ['cRest', 'restSec'], ['cReps', 'repeats'], ['cCool', 'cooldownMin'], ['cIncline', 'workIncline']]) {
    $(id).value = settings.custom[key];
  }
  const hasProfile = isCompleteProfile(profile);
  const bpmLimits = targetLimits(hasProfile ? maxHeartRate(profile) : null);
  const byHeart = heartPrograms();
  $('hTarget').min = bpmLimits.min;
  $('hTarget').max = bpmLimits.max;
  $('hTarget').value = byHeart.at(-1).heart.target;
  $('hMinutes').value = settings.heartCustom.minutes;
  $('hControl').value = settings.heartCustom.control;
  $('heartProgHint').textContent = hasProfile
    ? 'Needs the heart rate strap. The app changes speed or incline by itself, in small steps, to keep your pulse on target.'
    : 'Needs the heart rate strap. Fill in your profile under Settings to get programs for your own zones.';

  const programs = [...PRESETS, buildIntervals(settings.custom)];
  if (selectedProgram) selectedProgram = [...programs, ...byHeart].find((p) => p.id === selectedProgram.id) ?? null;
  const cardFor = (program) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `card${selectedProgram?.id === program.id ? ' selected' : ''}`;
    const extra = program.heart
      ? `<span class="bpm">${program.heart.target}<small>BPM</small></span>`
      : profileSvg(resolve(program, settings.levels, lim));
    card.innerHTML = `<b></b><span class="dur"></span><span class="blurb"></span>${extra}`;
    card.children[0].textContent = program.name;
    card.children[1].textContent = formatClock(totalSeconds(program));
    card.children[2].textContent = program.blurb;
    card.addEventListener('click', () => {
      selectedProgram = program;
      feedback(0);
      renderProgramSheet();
    });
    return card;
  };
  $('presetCards').replaceChildren(...programs.map(cardFor));
  $('heartCards').replaceChildren(...byHeart.map(cardFor));
  renderProgramHint();
  renderHistory();
}

/** Zone programs (when there is a profile) followed by the custom heart-rate program. */
function heartPrograms() {
  const hasProfile = isCompleteProfile(profile);
  const maxHr = hasProfile ? maxHeartRate(profile) : null;
  const zones = hasProfile ? heartZones(profile) : null;
  const custom = buildHeartProgram({
    target: settings.heartCustom.target ?? (zones ? Math.round((zones[1].from + zones[1].to) / 2) : 125),
    control: settings.heartCustom.control,
    holdMin: settings.heartCustom.minutes,
    maxHr,
  });
  return [...(zones ? heartPresets(zones, maxHr) : []), custom];
}

function renderProgramHint() {
  const p = selectedProgram;
  const clock = p ? formatClock(totalSeconds(p)) : '';
  $('programHint').textContent = !p
    ? 'Pick a program.'
    : uiState !== 'ready'
      ? 'Link the treadmill to start.'
      : !p.heart
        ? `${p.name} · ${clock}. Speeds change by themselves.`
        : !hasPulse()
          ? 'Link the heart rate strap first: tap the Bpm tile.'
          : p.heart.control === 'speed'
            ? `${p.name} · ${clock}. Speed follows your pulse, never above your Run speed (${toDisplaySpeed(settings.levels.run).toFixed(1)} ${speedUnit()}).`
            : `${p.name} · ${clock}. Incline follows your pulse at your Walk speed (${toDisplaySpeed(settings.levels.walk).toFixed(1)} ${speedUnit()}).`;
  renderControls();
}

function readNumber(id, fallback, lo, hi) {
  const n = Number($(id).value);
  return $(id).value !== '' && Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

function saveProgramInputs() {
  const lim = limits();
  for (const [id, key] of [['lvlWalk', 'walk'], ['lvlJog', 'jog'], ['lvlRun', 'run']]) {
    settings.levels[key] = round1(clamp(fromDisplaySpeed(readNumber(id, toDisplaySpeed(settings.levels[key]), 0.5, 30)), lim.minKph, lim.maxKph));
  }
  settings.custom = {
    warmupMin: readNumber('cWarm', 5, 0, 30),
    workSec: readNumber('cWork', 60, 5, 1800),
    restSec: readNumber('cRest', 60, 0, 1800),
    repeats: readNumber('cReps', 6, 1, 40),
    cooldownMin: readNumber('cCool', 3, 0, 30),
    workIncline: readNumber('cIncline', 0, 0, lim.maxIncline),
  };
  const bpmLimits = targetLimits(isCompleteProfile(profile) ? maxHeartRate(profile) : null);
  settings.heartCustom = {
    target: $('hTarget').value === '' ? null : Math.round(readNumber('hTarget', 125, bpmLimits.min, bpmLimits.max)),
    minutes: Math.round(readNumber('hMinutes', 20, 3, 120)),
    control: $('hControl').value === 'incline' ? 'incline' : 'speed',
  };
  store.set('levels', settings.levels);
  store.set('custom', settings.custom);
  store.set('heartCustom', settings.heartCustom);
  renderProgramSheet();
}

// ---------- history and summary ----------

function showSummary(summary, title) {
  const hasProfile = isCompleteProfile(profile);
  // Older history entries carry no report data; fill in what the profile alone allows.
  const full = summary.report || !hasProfile ? summary : { ...summary, report: buildReport({ seconds: summary.seconds }, profile) };
  reportSummary = summary;
  reportPages = renderReport(full, { imperial: imperial(), profile: hasProfile ? profile : null });
  $('summaryTitle').textContent = title;
  $('reportPages').replaceChildren(...reportPages);
  reportHint(hasProfile ? '' : 'Add your profile (Settings) to get heart-rate zones, VO2 max and calories for your weight.');
  if ($('programs').open) $('programs').close();
  if (!$('summary').open) $('summary').showModal();
}

function reportHint(message) {
  $('reportHint').textContent = message;
  $('reportHint').hidden = !message;
}

async function exportReport(mode) {
  if (!reportPages.length) return;
  try {
    const files = await reportFiles(reportPages, reportSummary.date);
    if (mode === 'share') {
      if (navigator.canShare?.({ files })) await navigator.share({ files, title: 'Treadmill workout' });
      else reportHint('Sharing is not available in this browser. Use Download instead.');
      return;
    }
    if (isAppleMobile()) {
      $('reportPages').replaceChildren(
        ...files.map((file) => {
          const img = new Image();
          img.src = URL.createObjectURL(file);
          img.alt = 'Workout report';
          return img;
        }),
      );
      reportHint('Touch and hold a picture, then choose Save to Photos.');
      return;
    }
    for (const file of files) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 15000);
    }
    reportHint(`Saved ${files.length} image${files.length === 1 ? '' : 's'} to your downloads.`);
  } catch (err) {
    if (err.name !== 'AbortError') reportHint(`Could not export the report: ${err.message}`);
  }
}

// ---------- profile ----------

const KG_PER_LB = 0.45359237;
const CM_PER_IN = 2.54;

/** Best current VO2 max: the middle of the last few heart-rate based estimates, else the profile formula. */
function currentVo2() {
  const recent = store.get('vo2log', []).slice(-5).map((e) => e.value).sort((a, b) => a - b);
  return recent.length ? { value: recent[Math.floor(recent.length / 2)], measured: true } : { value: vo2maxFromProfile(profile), measured: false };
}

function readProfileForm() {
  const num = (id) => ($(id).value === '' ? NaN : Number($(id).value));
  return {
    sex: $('pSex').value,
    age: Math.round(num('pAge')),
    weightKg: Math.round(num('pWeight') * (imperial() ? KG_PER_LB : 1) * 10) / 10,
    heightCm: Math.round(num('pHeight') * (imperial() ? CM_PER_IN : 1) * 10) / 10,
    restHr: num('pRest') > 0 ? Math.round(num('pRest')) : 0,
    maxHr: num('pMax') > 0 ? Math.round(num('pMax')) : 0,
    activity: Number($('pActivity').value),
  };
}

function renderProfile() {
  const p = profile ?? {};
  $('uWeight').textContent = imperial() ? 'Weight lb' : 'Weight kg';
  $('uHeight').textContent = imperial() ? 'Height in' : 'Height cm';
  $('pSex').value = p.sex ?? '';
  $('pAge').value = p.age ?? '';
  $('pWeight').value = p.weightKg ? Math.round((p.weightKg / (imperial() ? KG_PER_LB : 1)) * 10) / 10 : '';
  $('pHeight').value = p.heightCm ? Math.round((p.heightCm / (imperial() ? CM_PER_IN : 1)) * 10) / 10 : '';
  $('pRest').value = p.restHr || '';
  $('pMax').value = p.maxHr || '';
  $('pActivity').value = String(p.activity ?? 3);
  $('profileError').hidden = true;
  renderProfileFacts();
}

function renderProfileFacts() {
  const box = $('profileFacts');
  if (!isCompleteProfile(profile)) {
    box.replaceChildren();
    return;
  }
  const vo2 = currentVo2();
  const zones = heartZones(profile);
  const speeds = zoneSpeeds(vo2.value, profile);
  const row = (cls, ...cellsText) => {
    const el = document.createElement('div');
    el.className = cls;
    for (const t of cellsText) {
      const span = document.createElement('span');
      span.textContent = t;
      el.append(span);
    }
    return el;
  };
  const b = bmi(profile);
  box.replaceChildren(
    row('fact', 'VO2 max', `${vo2.value.toFixed(1)} · ${FITNESS_LABELS[fitnessLevel(vo2.value, profile)]}${vo2.measured ? '' : ' (from profile)'}`),
    row('fact', 'Max heart rate', `${maxHeartRate(profile)} bpm`),
    row('fact', 'BMI', `${b.toFixed(1)} · ${bmiLabel(b)}`),
    row('fact', 'Resting energy', `${bmr(profile)} kcal / day`),
    ...zones.map((z, i) => {
      const el = row(`zone${z.id === 2 ? ' fat' : ''}`, `Z${z.id}`, z.name, `${z.from}–${z.to} bpm`, `${toDisplaySpeed(speeds[i].from).toFixed(1)}–${toDisplaySpeed(speeds[i].to).toFixed(1)} ${speedUnit()}`);
      el.firstElementChild.style.background = z.color;
      return el;
    }),
  );
}

function saveProfile() {
  const next = readProfileForm();
  if (!isCompleteProfile(next)) {
    $('profileError').textContent = 'Please fill in sex, age, weight and height with realistic values.';
    $('profileError').hidden = false;
    return;
  }
  profile = next;
  store.set('profile', profile);
  store.set('profileAsked', true);
  $('profileError').hidden = true;
  renderProfileFacts();
  renderSettings();
  renderValues();
  feedback(880, 20);
}

function openProfile() {
  renderProfile();
  if ($('settings').open) $('settings').close();
  $('profile').showModal();
}

function renderHistory() {
  $('historyHint').textContent = history.length ? `${history.length} workout${history.length === 1 ? '' : 's'} saved on this device.` : 'No workouts yet.';
  $('clearHistoryBtn').hidden = !history.length;
  $('historyRows').replaceChildren(
    ...history.map((summary) => {
      const row = document.createElement('button');
      row.type = 'button';
      const km = summary.metres / 1000;
      const cells = [
        [new Date(summary.date).toLocaleDateString([], { day: 'numeric', month: 'short' }), new Date(summary.date).toLocaleTimeString([], { timeStyle: 'short' })],
        [formatClock(summary.seconds), 'time'],
        [(imperial() ? km / KM_PER_MILE : km).toFixed(2), distUnit()],
        [summary.kcal, 'kcal'],
      ];
      for (const [value, label] of cells) {
        const span = document.createElement('span');
        span.append(String(value), document.createElement('br'));
        const small = document.createElement('small');
        small.textContent = label;
        span.append(small);
        row.append(span);
      }
      row.addEventListener('click', () => showSummary(summary, 'Workout'));
      return row;
    }),
  );
}

// ---------- settings sheet ----------

/** Tapping the cat swaps it for the next one. */
function nextCat() {
  if (settings.cat === 'off' || !cat.ok) return;
  const keys = Object.keys(BREEDS);
  settings.cat = keys[(keys.indexOf(cat.breedKey) + 1) % keys.length];
  store.set('cat', settings.cat);
  applyCatStyle();
  feedback(0);
  const tag = $('catTag');
  tag.textContent = BREEDS[settings.cat].label;
  tag.classList.remove('show');
  void tag.offsetWidth; // restart the fade
  tag.classList.add('show');
}

function renderSettings() {
  $('unitsSel').value = imperial() ? 'imperial' : 'metric';
  $('catSel').value = settings.cat;
  $('holoChk').checked = settings.catHolo;
  $('soundChk').checked = settings.sound;
  $('demoChk').checked = settings.demo;
  $('showAllChk').checked = settings.showAll;
  $('trafficChk').checked = settings.traffic;
  $('log').textContent = logLines.join('\n');

  $('profileStatus').textContent = isCompleteProfile(profile)
    ? `${profile.age} y · ${profile.weightKg} kg · ${profile.heightCm} cm · VO2 max ${currentVo2().value.toFixed(1)}`
    : 'Not set — needed for zones, VO2 max and calories';

  const saved = store.get('code', null);
  $('codeStatus').textContent = client?.activation
    ? `Unlocked with "${client.activation.model}". Speed and incline control is enabled.`
    : uiState === 'monitor'
      ? 'No code was accepted, so the app can only display data. Try another code below.'
      : saved
        ? 'A working code is saved and will be tried first on the next connection.'
        : 'On first connection the app tries each known code until the treadmill accepts one.';

  const info = client?.info;
  const lim = limits();
  const facts = info
    ? [
        ['Device', client.transport.name],
        ['Firmware', info.firmware ?? 'unknown'],
        ['Serial', info.serial ?? 'unknown'],
        ['Reference', info.reference ?? 'unknown'],
        ['Speed range', `${lim.minKph}–${lim.maxKph} km/h`],
        ['Incline range', `${lim.minIncline}–${lim.maxIncline} %`],
        ['Characteristics', [...info.supported].join(', ') || 'none reported'],
      ]
    : [['Device', 'not connected']];
  $('facts').replaceChildren(
    ...facts.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function applyCatStyle() {
  $('stage').classList.toggle('no-cat', settings.cat === 'off' || !cat.ok);
  if (!cat.ok) return;
  if (settings.cat !== 'off') cat.setBreed(settings.cat);
  cat.setStyle(settings.catHolo ? 'holo' : 'tabby');
  if (settings.cat === 'off' || document.visibilityState !== 'visible') cat.stop();
  else cat.start();
}

// ---------- connection ----------

async function keepAwake() {
  try {
    if (!wakeLock && 'wakeLock' in navigator && client?.connected) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* not allowed right now (e.g. tab hidden); retried on visibility change */
  }
}

const NO_BLUETOOTH = () =>
  isAppleMobile()
    ? 'Safari and Chrome on iPhone and iPad cannot use Bluetooth from a web page. Install the free Bluefy browser from the App Store and open this same address in it. Demo mode (Settings) works here.'
    : 'This browser has no Web Bluetooth. Use Chrome or Edge on Android or a computer, or the Bluefy browser on iPhone/iPad. You can also turn on Demo mode in Settings.';

async function openTransport() {
  if (settings.demo) {
    // ?demo&warp=6 runs the pretend treadmill's clock faster, to try long programs quickly.
    const warp = clamp(Number(new URLSearchParams(location.search).get('warp')) || 1, 1, 20);
    const began = Date.now();
    return new SimulatorTransport(warp > 1 ? { now: () => began + (Date.now() - began) * warp } : {});
  }
  if (!bluetoothAvailable()) {
    throw new Error(NO_BLUETOOTH());
  }
  if (lastDevice) return new BluetoothTransport(lastDevice);
  const transport = await BluetoothTransport.request({ showAll: settings.showAll });
  lastDevice = transport.device;
  return transport;
}

async function connect() {
  banner(null);
  setState('busy', 'Scanning');
  let attempt;
  try {
    const transport = await openTransport();
    attempt = client = new IfitClient(transport, settings.demo ? { writeDelayMs: 0, settleMs: 150 } : {});
    client.addEventListener('log', (e) => log(e.detail));
    client.addEventListener('traffic', (e) => settings.traffic && log(e.detail));
    client.addEventListener('values', onValues);
    client.addEventListener('disconnected', () => {
      if (client !== attempt) return;
      cancelPending();
      wakeLock?.release();
      setState('disconnected', 'Link lost');
      banner('Connection lost. The treadmill keeps doing what it was doing: use its own buttons or pull the safety key to stop.', true);
      feedback(220, [80, 60, 80]);
    });

    setState('busy', `Linking ${transport.name}`);
    await client.connect();
    if (settings.units === null && client.info.limits.Metric === false) settings.units = 'imperial';
    renderPresets();

    const activation = await client.activate({
      preferred: store.get('code', null),
      onProgress: (i, total) => setState('busy', `Unlocking ${i}/${total}`),
    });
    if (client !== attempt) return;
    if (activation) {
      store.set('code', activation.code);
      setState('ready', transport.name);
      feedback(880, 20);
    } else {
      setState('monitor', 'Monitor only');
      banner('No unlock code was accepted, so the app shows live data but cannot control the treadmill. See Settings › Unlock code.');
    }
    prevMode = undefined;
    client.startPolling(1000);
    keepAwake();
  } catch (err) {
    if (client !== attempt && attempt) return; // cancelled by the user
    const cancelled = err.name === 'NotFoundError' && !lastDevice;
    lastDevice = null; // next attempt shows the device chooser again
    try {
      await attempt?.disconnect();
    } catch {
      /* already gone */
    }
    client = null;
    setState('disconnected', 'Offline');
    if (!cancelled) {
      log(`connect failed: ${err.message}`);
      banner(err.message, true);
    }
  }
}

async function disconnect() {
  const old = client;
  client = null;
  cancelPending();
  endProgram();
  wakeLock?.release();
  try {
    await old?.disconnect();
  } catch {
    /* already gone */
  }
  setState('disconnected', 'Offline');
  renderValues();
}

// ---------- wiring ----------

$('connectBtn').addEventListener('click', () => {
  feedback(0);
  if (uiState === 'disconnected') connect();
  else disconnect();
});

for (const b of document.querySelectorAll('[data-speed]')) holdable(b, () => nudge('Kph', Number(b.dataset.speed)));
for (const b of document.querySelectorAll('[data-incline]')) holdable(b, () => nudge('Incline', Number(b.dataset.incline)));

$('startBtn').addEventListener('click', () => {
  feedback(660, 20);
  if (isMoving(client?.values.Mode)) {
    cancelPending();
    modeCommand('Pause', () => client.pause());
  } else modeCommand('Start', () => client.start());
});
$('stopBtn').addEventListener('click', () => {
  feedback(330, 40);
  stopWorkout();
});
$('progEndBtn').addEventListener('click', () => {
  feedback(0);
  endProgram();
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
}
$('settingsBtn').addEventListener('click', () => {
  renderSettings();
  $('settings').showModal();
});
$('programsBtn').addEventListener('click', () => {
  renderProgramSheet();
  $('programs').showModal();
});
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('active', other === tab);
      $(other.dataset.tab).hidden = other !== tab;
    }
  });
}
for (const id of ['lvlWalk', 'lvlJog', 'lvlRun', 'cWarm', 'cWork', 'cRest', 'cReps', 'cCool', 'cIncline', 'hTarget', 'hMinutes', 'hControl']) {
  $(id).addEventListener('change', saveProgramInputs);
}
$('useCustomBtn').addEventListener('click', () => {
  saveProgramInputs();
  selectedProgram = buildIntervals(settings.custom);
  renderProgramSheet();
});
$('useHeartBtn').addEventListener('click', () => {
  saveProgramInputs();
  selectedProgram = heartPrograms().at(-1);
  renderProgramSheet();
});
$('startProgramBtn').addEventListener('click', () => {
  feedback(880, 30);
  startProgram();
});
$('clearHistoryBtn').addEventListener('click', () => {
  history = [];
  store.set('history', history);
  renderHistory();
});

$('unitsSel').addEventListener('change', (e) => {
  settings.units = e.target.value;
  store.set('units', settings.units);
  renderPresets();
  renderValues();
});
$('catSel').addEventListener('change', (e) => {
  settings.cat = e.target.value;
  store.set('cat', settings.cat);
  applyCatStyle();
});
$('holoChk').addEventListener('change', (e) => {
  settings.catHolo = e.target.checked;
  store.set('catHolo', settings.catHolo);
  applyCatStyle();
});
// Drag on the cat to turn the camera (sideways = around, up/down = height);
// a tap that does not move switches to the next cat.
{
  const stage = $('stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.program-bar') || !cat.ok || settings.cat === 'off') return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, speed: 0, at: performance.now() };
    cat.fling(0);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      stage.classList.add('dragging');
      try {
        stage.setPointerCapture(e.pointerId); // keep following the finger outside the cat view
      } catch {
        /* pointer already gone */
      }
    }
    const now = performance.now();
    const turn = (-dx / Math.max(160, stage.clientWidth)) * 3.6; // a full swipe is roughly 200 degrees
    cat.orbit(turn, (dy / Math.max(120, stage.clientHeight)) * 1.6);
    drag.speed = turn / Math.max(0.008, (now - drag.at) / 1000);
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.at = now;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, speed, at } = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (!moved) {
      if (e.type === 'pointerup') nextCat();
      return;
    }
    if (performance.now() - at < 80) cat.fling(speed * 0.6); // keep gliding after a flick
    store.set('view', { yaw: cat.yaw, pitch: cat.pitch });
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}
$('resetViewBtn').addEventListener('click', () => {
  cat.fling(0);
  cat.setView(DEFAULT_VIEW.yaw, DEFAULT_VIEW.pitch);
  store.set('view', null);
});
$('soundChk').addEventListener('change', (e) => {
  settings.sound = e.target.checked;
  store.set('sound', settings.sound);
});
$('demoChk').addEventListener('change', (e) => {
  settings.demo = e.target.checked;
  store.set('demo', settings.demo);
  lastDevice = null;
});
$('showAllChk').addEventListener('change', (e) => {
  settings.showAll = e.target.checked;
  store.set('showAll', settings.showAll);
  lastDevice = null;
});
$('trafficChk').addEventListener('change', (e) => (settings.traffic = e.target.checked));

$('profileBtn').addEventListener('click', openProfile);
$('saveProfileBtn').addEventListener('click', saveProfile);
$('shareReportBtn').addEventListener('click', () => exportReport('share'));
$('downloadReportBtn').addEventListener('click', () => exportReport('download'));
$('profile').addEventListener('close', () => store.set('profileAsked', true));

heart.addEventListener('change', () => {
  renderHeart();
  if ($('programs').open) renderProgramHint(); // a heart-rate program can start once the strap is linked
});
$('pulseCell').addEventListener('click', linkHeart);
$('heartBtn').addEventListener('click', () => {
  if (heart.state === 'off') linkHeart();
  else heart.unlink();
});

const codeSel = $('codeSel');
codeSel.append(new Option('Automatic (try all)', ''));
for (const c of CODES) codeSel.append(new Option(c.model.replaceAll('_', ' '), c.code));

$('applyCodeBtn').addEventListener('click', async () => {
  const custom = $('customCode').value.trim().toLowerCase();
  const code = custom || codeSel.value;
  if (custom && !isValidCode(custom)) {
    $('codeStatus').textContent = 'A custom code must be exactly 72 hex characters.';
    return;
  }
  if (!client?.connected) {
    if (code) store.set('code', code);
    $('codeStatus').textContent = code ? 'Saved. It will be tried first on the next connection.' : 'Connect first.';
    return;
  }
  $('codeStatus').textContent = 'Trying…';
  client.stopPolling();
  try {
    const result = await client.activate(code ? { only: code } : {});
    if (result) {
      store.set('code', result.code);
      setState('ready', client.transport.name);
      banner(null);
    } else {
      setState('monitor', 'Monitor only');
    }
  } catch (err) {
    log(`activation failed: ${err.message}`);
  }
  if (client?.connected) client.startPolling(1000);
  renderSettings();
});
$('forgetCodeBtn').addEventListener('click', () => {
  store.set('code', null);
  renderSettings();
});
$('copyLogBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    $('copyLogBtn').textContent = 'Copied';
  } catch {
    $('copyLogBtn').textContent = 'Copy failed';
  }
  setTimeout(() => ($('copyLogBtn').textContent = 'Copy log'), 1500);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
  applyCatStyle();
});
addEventListener('resize', () => renderValues());

// The service worker keeps a copy of the app on the device, so once it has been
// loaded (even through a USB-forwarded localhost) it opens without any server.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.storage?.persist?.())
    .catch(() => {});
}

// Handle for remote debugging from the PC (chrome://inspect).
window.ctlx = {
  get client() {
    return client;
  },
  get runner() {
    return runner;
  },
  session,
  cat,
  heart,
  logLines,
  settings,
};

// Older versions stored the hologram look as a cat choice.
if (settings.cat === 'holo') {
  settings.cat = 'tabby';
  settings.catHolo = true;
  store.set('cat', settings.cat);
  store.set('catHolo', true);
}
if (settings.cat !== 'off' && !(settings.cat in BREEDS)) settings.cat = 'tabby';
$('catSel').replaceChildren(
  ...Object.entries(BREEDS).map(([key, breed]) => new Option(breed.label, key)),
  new Option('Hidden', 'off'),
);

setState('disconnected', settings.demo ? 'Demo · offline' : 'Offline');
renderPresets();
renderValues();
applyCatStyle();

// First launch: ask for the profile once.
if (!isCompleteProfile(profile) && !store.get('profileAsked', false)) setTimeout(openProfile, 700);

// On iPhone and iPad say straight away why Link cannot work in this browser.
if (isAppleMobile() && !bluetoothAvailable() && !settings.demo) banner(NO_BLUETOOTH());
