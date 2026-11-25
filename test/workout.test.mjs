import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, ProgramRunner, buildIntervals, formatClock, resolve, totalSeconds } from '../js/programs.js';
import { Session, addToHistory, downsample } from '../js/session.js';
import { parseHeartRate } from '../js/heart.js';

const LIMITS = { minKph: 1.5, maxKph: 19.3, minIncline: 0, maxIncline: 12 };

test('presets are well formed', () => {
  for (const p of PRESETS) {
    assert.ok(p.steps.length >= 3, p.id);
    assert.ok(p.steps.every((s) => s.seconds > 0 && s.label), p.id);
    assert.ok(totalSeconds(p) >= 600 && totalSeconds(p) <= 3600, p.id);
  }
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  assert.equal(totalSeconds(PRESETS.find((p) => p.id === 'intervals')), 300 + 6 * 180 + 240);
});

test('resolve maps levels to speeds and clamps to the treadmill', () => {
  const steps = resolve(PRESETS[0], { walk: 0.5, jog: 7, run: 30 }, LIMITS);
  assert.equal(steps[0].kph, 1.5);
  assert.equal(steps[1].kph, 19.3);
  assert.equal(steps[1].start, 300);
  const hills = resolve(PRESETS.find((p) => p.id === 'hills'), undefined, { ...LIMITS, maxIncline: 6 });
  assert.equal(Math.max(...hills.map((s) => s.incline)), 6);
});

test('custom intervals build the expected sequence', () => {
  const p = buildIntervals({ warmupMin: 2, workSec: 45, restSec: 15, repeats: 3, cooldownMin: 0, workIncline: 2 });
  assert.deepEqual(p.steps.map((s) => s.seconds), [120, 45, 15, 45, 15, 45, 15]);
  assert.equal(p.steps[1].incline, 2);
  assert.equal(formatClock(3725), '1:02:05');
});

test('runner applies each step once, counts down and finishes', () => {
  const program = buildIntervals({ warmupMin: 1, workSec: 30, restSec: 30, repeats: 2, cooldownMin: 1 });
  const runner = new ProgramRunner(program, { walk: 4, jog: 6, run: 9 }, LIMITS);
  assert.equal(runner.total, 240);

  let s = runner.update(0);
  assert.equal(s.apply.kph, 4);
  assert.equal(s.index, 0);
  assert.equal(runner.update(10).apply, null);

  s = runner.update(58);
  assert.equal(s.countdown, 2);
  assert.equal(s.next.kph, 9);

  s = runner.update(60);
  assert.equal(s.apply.kph, 9);
  assert.equal(s.step.label, 'Work 1/2');
  assert.equal(s.remaining, 30);
  assert.equal(runner.update(59).index, 1); // jitter never steps back

  s = runner.update(125); // skipped past a boundary between polls
  assert.equal(s.index, 3);
  assert.equal(s.apply.kph, 9);

  s = runner.update(240);
  assert.equal(s.done, true);
  assert.equal(s.finishedNow, true);
  assert.equal(runner.update(250).finishedNow, false);
});

test('session accumulates, survives the zeros reported during a pause, and summarises', () => {
  const session = new Session();
  session.update({ seconds: 0, metres: 0, kph: 0, running: false }, 1000);
  assert.equal(session.active, false);

  for (let t = 1; t <= 600; t++) {
    session.update({ seconds: t, metres: t * 2, kcal: t / 10, kph: 7.2, incline: 5, hr: t <= 300 ? 120 : 160, running: true }, 1000 + t * 1000);
  }
  session.update({ seconds: 0, metres: 0, kcal: 0, kph: 0, incline: 0, running: false }, 700000); // paused
  assert.equal(session.seconds, 600);
  assert.equal(session.metres, 1200);
  assert.ok(Math.abs(session.elevation - 60) < 0.2);
  assert.ok(Math.abs(session.avgKph - 7.2) < 0.01);
  assert.equal(session.samples.length, 300);

  const summary = session.summary();
  assert.equal(summary.kcal, 60);
  assert.equal(summary.maxKph, 7.2);
  assert.equal(summary.avgHr, 140);
  assert.equal(summary.maxHr, 160);
  assert.equal(summary.series[0].length, 4);
  assert.ok(summary.series.length <= 60);
  assert.equal(addToHistory([{ a: 1 }, { a: 2 }], summary, 2).length, 2);
  assert.deepEqual(downsample([], 10), []);
});

test('heart rate measurements decode in both formats', () => {
  // 8-bit value, contact detected, two RR intervals (1024 units = 1 s)
  assert.deepEqual(parseHeartRate(Uint8Array.from([0x16, 72, 0x00, 0x04, 0x00, 0x02])), { bpm: 72, contact: true, rr: [1000, 500] });
  // 16-bit value with energy expended present
  assert.deepEqual(parseHeartRate(Uint8Array.from([0x09, 0x2c, 0x01, 0xff, 0xff])), { bpm: 300, contact: true, rr: [] });
  // contact supported but not detected (strap not on skin)
  assert.equal(parseHeartRate(Uint8Array.from([0x04, 0])).contact, false);
});

test('session tracks oxygen use and time at each heart rate', () => {
  const session = new Session();
  for (let t = 0; t <= 600; t++) {
    session.update({ seconds: t, metres: t * 2.5, kph: 9, incline: 0, hr: t < 300 ? 130 : 150, running: true }, t * 1000);
  }
  // 9 km/h flat costs 3.5 + 0.2 * 150 = 33.5 ml/kg/min, for 10 minutes
  assert.ok(Math.abs(session.o2PerKg - 335) < 1);
  assert.equal(session.hrSeconds[130], 299);
  assert.equal(session.hrSeconds[150], 301);
});
