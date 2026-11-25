import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bmi, bmr, buildReport, fitnessLevel, heartZones, isCompleteProfile, maxHeartRate, oxygenCost,
  speedForOxygen, vo2maxFromProfile, vo2maxFromSamples, zoneOf, zoneSpeeds,
} from '../js/fitness.js';

const man = { sex: 'male', age: 40, weightKg: 80, heightCm: 180 };
const woman = { sex: 'female', age: 30, weightKg: 60, heightCm: 165, restHr: 55 };

test('profile validation', () => {
  assert.ok(isCompleteProfile(man));
  assert.ok(!isCompleteProfile({ ...man, age: 0 }));
  assert.ok(!isCompleteProfile({ ...man, sex: undefined }));
  assert.ok(!isCompleteProfile(null));
});

test('heart-rate maximum and zones', () => {
  assert.equal(maxHeartRate(man), 180); // 208 - 0.7 * 40
  assert.equal(maxHeartRate({ ...man, maxHr: 192 }), 192);
  const zones = heartZones(man);
  assert.deepEqual(zones.map((z) => [z.from, z.to]), [[90, 107], [108, 125], [126, 143], [144, 161], [162, 180]]);
  assert.equal(zones[1].name, 'Fat burn');
  assert.deepEqual([80, 90, 120, 143, 144, 179, 200].map((bpm) => zoneOf(zones, bpm)), [0, 1, 2, 3, 4, 5, 5]);
  // With a resting heart rate the zones use heart-rate reserve (Karvonen): 55 + 0.6 * (187 - 55)
  const reserve = heartZones(woman);
  assert.equal(maxHeartRate(woman), 187);
  assert.equal(reserve[1].from, 134);
});

test('oxygen cost follows the ACSM equations and has no jump between them', () => {
  assert.ok(Math.abs(oxygenCost(5, 0) - (3.5 + 0.1 * 83.333)) < 0.01); // walking
  assert.ok(Math.abs(oxygenCost(10, 0) - (3.5 + 0.2 * 166.667)) < 0.01); // running
  assert.ok(Math.abs(oxygenCost(5, 10) - (3.5 + 8.3333 + 1.8 * 83.333 * 0.1)) < 0.01);
  assert.equal(oxygenCost(0, 0), 3.5);
  for (let v = 3; v < 14; v += 0.1) assert.ok(oxygenCost(v + 0.1, 0) > oxygenCost(v, 0));
  assert.ok(Math.abs(speedForOxygen(oxygenCost(11.3, 0)) - 11.3) < 0.06);
});

test('body numbers', () => {
  assert.ok(Math.abs(bmi(man) - 24.69) < 0.01);
  assert.equal(bmr(man), 1730); // 800 + 1125 - 200 + 5
  assert.equal(bmr(woman), 1320); // 600 + 1031.25 - 150 - 161, rounded
});

test('VO2 max from profile and from a steady run', () => {
  const base = vo2maxFromProfile(man); // 56.363 + 1.921*3 - 0.381*40 - 0.754*24.69 + 10.987
  assert.ok(Math.abs(base - 39.25) < 0.1);
  assert.ok(vo2maxFromProfile({ ...man, activity: 7 }) > base + 7);

  // 20 minutes at 10 km/h with a heart rate of 150: reserve = (150-65)/(180-65) = 0.739
  const samples = [];
  for (let t = 0; t <= 1200; t += 2) samples.push({ t, kph: 10, incline: 0, hr: t < 120 ? 110 : 150 });
  const fromRun = vo2maxFromSamples(samples, man);
  assert.ok(Math.abs(fromRun - (3.5 + 33.333 / 0.7391)) < 0.2);
  assert.equal(fitnessLevel(fromRun, man), 4); // 48.6 is "Superior" for a 40-year-old man
  assert.equal(fitnessLevel(30, man), 0);

  assert.equal(vo2maxFromSamples(samples.slice(0, 80), man), null); // too short
  assert.equal(vo2maxFromSamples(samples.map((s) => ({ ...s, hr: 0 })), man), null); // no heart rate
  const jumpy = samples.map((s, i) => ({ ...s, kph: i % 20 < 10 ? 6 : 12 }));
  assert.equal(vo2maxFromSamples(jumpy, man), null); // never steady
});

test('report: zones, personal calories, fat estimate', () => {
  const hrSeconds = new Array(256).fill(0);
  hrSeconds[115] = 600; // zone 2
  hrSeconds[150] = 300; // zone 4
  hrSeconds[70] = 60; // below zone 1
  const report = buildReport({ seconds: 960, o2PerKg: 335, hrSeconds, samples: [] }, man);
  assert.deepEqual(report.zoneSeconds, [60, 0, 600, 0, 300, 0]);
  assert.equal(report.hrTracked, 960);
  assert.equal(report.mainZone, 2);
  assert.equal(report.kcal, 134); // 335 ml/kg * 80 kg = 26.8 L of oxygen, about 5 kcal each
  assert.ok(report.fatGrams > 4 && report.fatGrams < 9);
  assert.equal(report.vo2Source, 'profile');
  assert.equal(report.maxHr, 180);

  const noHeart = buildReport({ seconds: 600, o2PerKg: 200, hrSeconds: [], samples: [] }, man);
  assert.equal(noHeart.hrTracked, 0);
  assert.equal(noHeart.mainZone, null);
});

test('zone speeds rise with the zone and with fitness', () => {
  const speeds = zoneSpeeds(45, man);
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i].from >= speeds[i - 1].from);
  assert.ok(zoneSpeeds(55, man)[2].to > speeds[2].to);
});
