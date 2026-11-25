import test from 'node:test';
import assert from 'node:assert/strict';

import { HeartController, HeartRunner, buildHeartProgram, heartPresets, targetLimits } from '../js/hrcontrol.js';
import { heartZones, maxHeartRate, oxygenCost } from '../js/fitness.js';
import { totalSeconds } from '../js/programs.js';

const LIMITS = { minKph: 1.5, maxKph: 19.3, minIncline: 0, maxIncline: 12 };
const LEVELS = { walk: 4.5, jog: 7, run: 11 };

/**
 * A pretend runner on a pretend belt. The pulse heads for the level that the
 * effort calls for, with a lag, plus a little jitter; the belt follows `apply`.
 * `pulseAt(t, hr)` can replace the reading the app would get (0 = strap silent).
 */
function simulate(program, { levels = LEVELS, vo2max = 42, rest = 60, max = 186, lag = 40, pulseAt = (t, hr) => hr, upTo = Infinity } = {}) {
  const runner = new HeartRunner(program, levels, LIMITS, { maxHr: max });
  let hr = rest;
  let kph = 0;
  let incline = 0;
  let seed = 7;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 2;
  };
  const trace = [];
  for (let t = 0; t < Math.min(runner.total + 5, upTo); t++) {
    const demand = rest + (max - rest) * Math.min(1.05, (oxygenCost(kph, incline) - 3.5) / (vo2max - 3.5));
    hr += (demand - hr) / lag;
    const state = runner.update(t, { hr: pulseAt(t, Math.round(hr + jitter())) });
    if (state.done) break;
    if (state.apply) ({ kph, incline } = state.apply);
    trace.push({ t, hr, kph, incline, action: state.heart.action, index: state.index, quiet: !!state.apply?.quiet });
  }
  return { runner, trace };
}

test('heart programs are built from the zones and stay inside safe targets', () => {
  const profile = { sex: 'male', age: 40, weightKg: 80, heightCm: 180 };
  const zones = heartZones(profile);
  const programs = heartPresets(zones, maxHeartRate(profile));
  assert.equal(programs.length, 4);
  assert.equal(new Set(programs.map((p) => p.id)).size, 4);
  for (const p of programs) {
    assert.equal(p.steps.length, 3);
    assert.ok(p.steps[1].hold);
    assert.ok(totalSeconds(p) >= 15 * 60 && totalSeconds(p) <= 45 * 60, p.id);
    assert.ok(p.heart.target <= targetLimits(maxHeartRate(profile)).max, p.id);
  }
  const fatburn = programs.find((p) => p.id === 'hr-fatburn');
  assert.ok(fatburn.heart.target >= zones[1].from && fatburn.heart.target <= zones[1].to);
  assert.equal(programs.find((p) => p.id === 'hr-hill').heart.control, 'incline');

  // Targets are clamped, with or without a known maximum heart rate.
  assert.equal(buildHeartProgram({ target: 250, maxHr: 180 }).heart.target, 162);
  assert.equal(buildHeartProgram({ target: 250 }).heart.target, 170);
  assert.equal(buildHeartProgram({ target: 20 }).heart.target, 80);
});

test('speed control settles on the target pulse without overshooting', () => {
  const program = buildHeartProgram({ target: 140, control: 'speed', holdMin: 25 });
  const { trace } = simulate(program);
  const hold = trace.filter((s) => s.index === 1);
  const settled = hold.filter((s) => s.t > 240 + 600);
  assert.ok(Math.max(...hold.map((s) => s.hr)) < 140 + 9, `peak ${Math.max(...hold.map((s) => s.hr)).toFixed(1)}`);
  assert.ok(settled.every((s) => Math.abs(s.hr - 140) <= 6), 'stays within 6 bpm once settled');
  assert.ok(hold.every((s) => s.incline === 0), 'incline is left alone');
  assert.ok(hold.every((s) => s.kph >= 3 && s.kph <= LEVELS.run));
  // Small steps only, and never two pushes close together.
  const changes = hold.filter((s) => s.quiet);
  for (let i = 1; i < hold.length; i++) assert.ok(hold[i].kph - hold[i - 1].kph <= 0.5 + 1e-9);
  const ups = changes.filter((s) => s.action === 'up');
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i].t - ups[i - 1].t >= 20);
  // Warm-up and cool-down are plain walking.
  assert.ok(trace.filter((s) => s.index === 0).every((s) => s.kph === 4.5));
  assert.ok(trace.filter((s) => s.index === 2).every((s) => s.kph <= 4.5 && s.incline === 0));
});

test('incline control holds the pulse at a fixed walking speed', () => {
  const program = buildHeartProgram({ target: 125, control: 'incline', holdMin: 25 });
  const { trace } = simulate(program, { levels: { ...LEVELS, walk: 5.5 } });
  const hold = trace.filter((s) => s.index === 1);
  const settled = hold.filter((s) => s.t > 240 + 600);
  assert.ok(hold.every((s) => s.kph === 5.5), 'speed is left alone');
  assert.ok(Math.max(...hold.map((s) => s.incline)) > 2);
  assert.ok(hold.every((s) => s.incline >= 0 && s.incline <= 12 && Number.isInteger(s.incline * 2)));
  assert.ok(Math.max(...hold.map((s) => s.hr)) < 125 + 9);
  assert.ok(settled.every((s) => Math.abs(s.hr - 125) <= 6));
  assert.equal(trace.at(-1).incline, 0, 'cool-down is on the flat');
});

test('a fitter or less fit runner ends up at a different speed, same pulse', () => {
  const program = buildHeartProgram({ target: 135, control: 'speed', holdMin: 25 });
  const end = (vo2max) => simulate(program, { vo2max }).trace.filter((s) => s.index === 1).at(-1);
  const fit = end(55);
  const unfit = end(32);
  assert.ok(fit.kph > unfit.kph + 1.5, `${fit.kph} vs ${unfit.kph}`);
  assert.ok(Math.abs(fit.hr - 135) <= 6 && Math.abs(unfit.hr - 135) <= 6);
});

test('the speed never passes the Run level, and says so', () => {
  const program = buildHeartProgram({ target: 160, control: 'speed', holdMin: 20 });
  const { trace } = simulate(program, { levels: { walk: 4.5, jog: 6, run: 7 }, vo2max: 55 });
  assert.equal(Math.max(...trace.map((s) => s.kph)), 7);
  assert.equal(trace.filter((s) => s.index === 1).at(-1).action, 'top');
});

test('a lost pulse never speeds the belt up and eases it off after half a minute', () => {
  const program = buildHeartProgram({ target: 150, control: 'speed', holdMin: 20 });
  const lostAt = 240 + 200;
  const { trace } = simulate(program, { pulseAt: (t, hr) => (t >= lostAt ? 0 : hr), upTo: lostAt + 240 });
  const before = trace.find((s) => s.t === lostAt - 1).kph;
  assert.ok(before > 5.5, 'it had already sped up');
  const after = trace.filter((s) => s.t >= lostAt);
  assert.ok(after.every((s) => s.kph <= before), 'no increase without a pulse');
  assert.equal(trace.find((s) => s.t === lostAt + 25).kph, before, 'held at first');
  assert.equal(after.at(-1).kph, 4.5, 'then back to walking');
  assert.ok(after.slice(10).every((s) => ['nosignal', 'ease'].includes(s.action)));
});

test('a pulse far above target drops straight back to the easy setting', () => {
  const c = new HeartController({ target: 130, control: 'speed', floor: 3, ceil: 11, rest: 4.5, maxHr: 185 });
  c.restart(0);
  assert.equal(c.update({ t: 1, hr: 131, value: 9 }).action, 'hold');
  assert.deepEqual(c.update({ t: 20, hr: 170, value: 9 }), { action: 'drop', value: 4.5, bpm: 170, target: 130 });

  // A reading at the maximum heart rate does the same, even with a high target.
  const high = new HeartController({ target: 165, control: 'incline', floor: 0, ceil: 12, rest: 0, maxHr: 185 });
  high.restart(0);
  assert.equal(high.update({ t: 5, hr: 186, value: 8 }).value, 0);

  // Moderately high: one larger step down, not a full drop.
  const mid = new HeartController({ target: 130, control: 'speed', floor: 3, ceil: 11, rest: 4.5 });
  mid.restart(0);
  const out = mid.update({ t: 10, hr: 144, value: 9 });
  assert.equal(out.action, 'drop');
  assert.equal(out.value, 8);
});

test('a change by hand is kept and the controller waits before touching it', () => {
  const program = buildHeartProgram({ target: 140, control: 'speed', holdMin: 20, warmupMin: 1 });
  const runner = new HeartRunner(program, LEVELS, LIMITS);
  for (let t = 0; t <= 61; t++) runner.update(t, { hr: 95 });
  runner.manual('Kph', 8);
  assert.equal(runner.current.kph, 8);
  for (let t = 62; t < 81; t++) assert.equal(runner.update(t, { hr: 95 }).apply, null);
  const next = runner.update(82, { hr: 95 });
  assert.equal(next.apply.kph, 8.5);
  assert.ok(next.apply.quiet);
});
