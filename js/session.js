// Tracks one workout from the treadmill's live values: totals, averages,
// elevation gain and a sampled speed/incline series for the chart and history.
// Pure logic, covered by the Node tests.

import { oxygenCost } from './fitness.js';

const SAMPLE_EVERY_S = 2;
const MAX_SAMPLES = 1800;

export class Session {
  constructor() {
    this.reset();
  }

  reset() {
    this.seconds = 0;
    this.metres = 0;
    this.kcal = 0;
    this.elevation = 0;
    this.maxKph = 0;
    this.maxHr = 0;
    this._hrSum = 0;
    this._hrCount = 0;
    this.o2PerKg = 0; // oxygen used so far, ml per kg of body weight (for personal calories)
    this.hrSeconds = new Array(256).fill(0); // seconds spent at each heart rate
    this._prevT = null;
    this.samples = []; // { t, kph, incline, hr }
    this.startedAt = null;
    this._lastSample = -Infinity;
  }

  get active() {
    return this.startedAt !== null;
  }

  /**
   * Feed one reading. `running` is true while the belt moves.
   * The treadmill reports zeros while paused, so totals only ever grow within a session.
   */
  update({ seconds = 0, metres = 0, kcal = 0, kph = 0, incline = 0, hr = 0, running = false }, now = Date.now()) {
    if (running && this.startedAt === null) this.startedAt = now;
    if (this.startedAt === null) return;
    if (seconds >= this.seconds) this.seconds = seconds;
    if (metres > this.metres) {
      this.elevation += ((metres - this.metres) * Math.max(0, incline)) / 100;
      this.metres = metres;
    }
    if (kcal > this.kcal) this.kcal = kcal;
    if (!running) return;
    const dt = this._prevT === null ? 0 : seconds - this._prevT;
    this._prevT = seconds;
    if (dt > 0 && dt <= 5) {
      this.o2PerKg += (oxygenCost(kph, incline) * dt) / 60;
      if (hr > 0) this.hrSeconds[Math.min(255, Math.round(hr))] += dt;
    }
    this.maxKph = Math.max(this.maxKph, kph);
    if (hr > 0) {
      this.maxHr = Math.max(this.maxHr, hr);
      this._hrSum += hr;
      this._hrCount += 1;
    }
    if (this.seconds - this._lastSample >= SAMPLE_EVERY_S) {
      this._lastSample = this.seconds;
      this.samples.push({ t: this.seconds, kph, incline, hr });
      if (this.samples.length > MAX_SAMPLES) this.samples = this.samples.filter((_, i) => i % 2 === 0);
    }
  }

  get avgKph() {
    return this.seconds > 0 ? this.metres / 1000 / (this.seconds / 3600) : 0;
  }

  get avgHr() {
    return this._hrCount ? this._hrSum / this._hrCount : 0;
  }

  summary() {
    return {
      date: this.startedAt ?? Date.now(),
      seconds: Math.round(this.seconds),
      metres: Math.round(this.metres),
      kcal: Math.round(this.kcal),
      elevation: Math.round(this.elevation * 10) / 10,
      avgKph: Math.round(this.avgKph * 100) / 100,
      maxKph: Math.round(this.maxKph * 10) / 10,
      avgHr: Math.round(this.avgHr),
      maxHr: Math.round(this.maxHr),
      series: downsample(this.samples, 60),
    };
  }
}

/** Reduce a sample series to at most `max` points of [t, kph, incline, hr]. */
export function downsample(samples, max) {
  if (!samples.length) return [];
  const stride = Math.max(1, Math.ceil(samples.length / max));
  const out = [];
  for (let i = 0; i < samples.length; i += stride) {
    const s = samples[i];
    out.push([Math.round(s.t), Math.round(s.kph * 10) / 10, Math.round(s.incline * 10) / 10, Math.round(s.hr || 0)]);
  }
  return out;
}

/** Add a finished workout to the stored history list (newest first, capped). */
export function addToHistory(history, summary, cap = 60) {
  return [summary, ...history].slice(0, cap);
}
