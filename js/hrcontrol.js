// Heart-rate controlled programs: the app changes speed or incline by itself to
// hold a target pulse. Pure logic (no DOM, no Bluetooth), covered by the Node tests.
//
// Heart rate answers a change of pace slowly (half a minute or more), so the
// controller moves in small steps, waits between them, and looks at where the
// pulse is heading before it pushes harder. It is quicker to ease off than to
// push, and it never pushes without a fresh reading.

import { DEFAULT_LEVELS, resolve } from './programs.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (list, pick) => list.reduce((sum, item) => sum + pick(item), 0) / list.length;

const BAND = 3; // bpm either side of the target that counts as on target
const UP_EVERY = 20; // seconds to wait after any change before pushing harder
const DOWN_EVERY = 12; // seconds to wait after any change before easing off
const LOOKAHEAD = 30; // seconds the current trend is projected forward
const SIGNAL_GRACE = 8; // seconds without a reading before the pulse counts as lost
const SIGNAL_HOLD = 30; // seconds without a reading before the workout is eased off
const OVER_DROP = 12; // bpm above target that triggers one large step down
const OVER_BAIL = 25; // bpm above target that sends the belt straight back to the easy setting

// Step sizes: `unit` is the smallest step, gains are step per bpm of error.
const TUNING = {
  speed: { unit: 0.1, upGain: 0.035, upMax: 0.5, downGain: 0.05, downMax: 0.8, drop: 1, ease: 0.5 },
  incline: { unit: 0.5, upGain: 0.08, upMax: 1, downGain: 0.1, downMax: 1.5, drop: 2, ease: 1 },
};

/** Zone programs: `at` is how far into the zone the target sits (0 = bottom, 1 = top). */
export const HEART_PRESETS = [
  { id: 'hr-fatburn', name: 'Fat burn hold', zone: 2, at: 0.55, control: 'speed', holdMin: 30 },
  { id: 'hr-hill', name: 'Hill walk hold', zone: 2, at: 0.75, control: 'incline', holdMin: 25 },
  { id: 'hr-cardio', name: 'Cardio hold', zone: 3, at: 0.5, control: 'speed', holdMin: 25 },
  { id: 'hr-tempo', name: 'Tempo hold', zone: 4, at: 0.3, control: 'speed', holdMin: 15 },
];

/** Lowest and highest pulse a program may aim for. */
export function targetLimits(maxHr = null) {
  return { min: 80, max: maxHr > 0 ? Math.round(maxHr * 0.9) : 170 };
}

/** A warm-up, a stretch held at `target` bpm, and a cool-down. */
export function buildHeartProgram({
  id = 'hr-custom',
  name = 'Custom heart rate',
  target,
  control = 'speed',
  holdMin = 20,
  warmupMin = 4,
  cooldownMin = 3,
  note = '',
  maxHr = null,
}) {
  const lim = targetLimits(maxHr);
  const bpm = Math.round(clamp(target, lim.min, lim.max));
  const mode = control === 'incline' ? 'incline' : 'speed';
  return {
    id,
    name,
    blurb: `${note ? `${note} · ` : ''}${bpm} bpm · changes the ${mode}`,
    heart: { target: bpm, control: mode },
    steps: [
      { label: 'Warm-up', seconds: Math.round(warmupMin * 60), level: 'walk', incline: 0 },
      { label: `Hold ${bpm} bpm`, seconds: Math.round(clamp(holdMin, 3, 120) * 60), level: 'walk', incline: 0, hold: true },
      { label: 'Cool-down', seconds: Math.round(cooldownMin * 60), level: 'walk', incline: 0 },
    ],
  };
}

/** The zone programs for a set of heart-rate zones (see fitness.heartZones). */
export function heartPresets(zones, maxHr = null) {
  return HEART_PRESETS.map((preset) => {
    const zone = zones[preset.zone - 1];
    return buildHeartProgram({
      ...preset,
      target: zone.from + preset.at * (zone.to - zone.from),
      note: `Zone ${zone.id} ${zone.name.toLowerCase()}`,
      maxHr,
    });
  });
}

/**
 * Decides, once a second, whether the controlled setting (speed in km/h or
 * incline in %) should change. `floor`..`ceil` is the range it may use and
 * `rest` the easy setting it falls back to when the pulse is lost or far too high.
 */
export class HeartController {
  constructor({ target, control = 'speed', floor, ceil, rest = floor, maxHr = null }) {
    this.target = target;
    this.control = control;
    this.k = TUNING[control];
    this.floor = floor;
    this.ceil = ceil;
    this.rest = rest;
    this.maxHr = maxHr;
    this._readings = [];
    this._changedAt = null;
    this._seenAt = null;
  }

  /** Start afresh: at the beginning of the hold and after a pause. */
  restart(t) {
    this._readings = [];
    this._changedAt = t;
    this._seenAt = t;
  }

  /** The setting was changed by hand: give the pulse time to answer before judging it. */
  touch(t) {
    this._changedAt = t;
  }

  _snap(value) {
    return Math.round(Math.round(value / this.k.unit) * this.k.unit * 100) / 100;
  }

  /**
   * @param t      workout seconds
   * @param hr     latest pulse, 0 when there is no fresh reading
   * @param value  the setting as it is now
   * @returns { action, value, bpm, target }; `value` differs from the input when a change is due.
   *   action: wait | hold | low | high | up | down | drop | top | bottom | nosignal | ease
   */
  update({ t, hr, value }) {
    if (this._changedAt === null) this.restart(t);
    if (hr > 0) {
      this._readings.push({ t, hr });
      this._seenAt = t;
    }
    this._readings = this._readings.filter((r) => r.t > t - 32);
    const since = t - this._changedAt;
    const k = this.k;
    const answer = (action, next = value, bpm = 0) => {
      const snapped = this._snap(next);
      if (snapped !== value) this._changedAt = t;
      return { action, value: snapped, bpm: Math.round(bpm), target: this.target };
    };

    // No fresh pulse: never push. After a while, ease back to the easy setting.
    if (t - this._seenAt > SIGNAL_GRACE) {
      if (t - this._seenAt > SIGNAL_HOLD && since >= DOWN_EVERY && value > this.rest) {
        return answer('ease', Math.max(this.rest, value - k.ease));
      }
      return answer('nosignal');
    }

    const recentList = this._readings.filter((r) => r.t > t - 10);
    if (!recentList.length) return answer('wait');
    const recent = mean(recentList, (r) => r.hr);
    const olderList = this._readings.filter((r) => r.t <= t - 15);
    let ahead = recent;
    if (olderList.length) {
      const span = mean(recentList, (r) => r.t) - mean(olderList, (r) => r.t);
      const slope = (recent - mean(olderList, (r) => r.hr)) / Math.max(5, span);
      ahead = recent + clamp(slope * LOOKAHEAD, -10, 10);
    }

    // Far too high: back to the easy setting at once.
    if ((this.maxHr > 0 && recent >= this.maxHr) || recent >= this.target + OVER_BAIL) {
      return answer('drop', Math.min(value, this.rest), recent);
    }
    if (recent >= this.target + OVER_DROP && since >= 8) {
      return answer('drop', Math.max(this.floor, value - k.drop), recent);
    }

    // Push only if the pulse is low now and will still be low where it is heading;
    // ease off only if it is high now and still will be.
    const low = this.target - Math.max(recent, ahead);
    const high = Math.min(recent, ahead) - this.target;
    if (low > BAND) {
      if (value >= this.ceil) return answer('top', value, recent);
      if (since < UP_EVERY) return answer('low', value, recent);
      const step = clamp(this._snap(low * k.upGain), k.unit, k.upMax);
      return answer('up', Math.min(this.ceil, value + step), recent);
    }
    if (high > BAND) {
      if (value <= this.floor) return answer('bottom', value, recent);
      if (since < DOWN_EVERY) return answer('high', value, recent);
      const step = clamp(this._snap(high * k.downGain), k.unit, k.downMax);
      return answer('down', Math.max(this.floor, value - step), recent);
    }
    return answer('hold', value, recent);
  }
}

/**
 * Runs a heart-rate program. Same shape as ProgramRunner, so the app drives both
 * alike: call update(elapsedSeconds, { hr }) once a second and send `apply` to the
 * treadmill whenever it is set. During the hold, `apply.quiet` marks a small
 * automatic adjustment rather than a new step.
 */
export class HeartRunner {
  constructor(program, levels = DEFAULT_LEVELS, limits = {}, { maxHr = null } = {}) {
    const { minKph = 1, maxKph = 20, minIncline = 0, maxIncline = 12 } = limits;
    this.program = program;
    this.heart = program.heart;
    this.steps = resolve(program, levels, limits);
    this.total = this.steps.reduce((sum, s) => sum + s.seconds, 0);
    this.holdIndex = program.steps.findIndex((s) => s.hold);
    this.index = -1;
    this.done = false;
    this.walk = this.steps[0].kph;
    this.key = this.heart.control === 'speed' ? 'kph' : 'incline';
    const flat = Math.max(0, minIncline);
    const range =
      this.key === 'kph'
        ? {
            floor: Math.max(minKph, Math.min(this.walk, 3)),
            ceil: Math.max(this.walk, clamp(levels.run ?? DEFAULT_LEVELS.run, minKph, maxKph)),
            rest: this.walk,
          }
        : { floor: flat, ceil: maxIncline, rest: flat };
    this.range = range;
    this.flat = flat;
    this.controller = new HeartController({ target: this.heart.target, control: this.heart.control, ...range, maxHr });
    this.set = { kph: this.walk, incline: flat };
    this.status = { action: 'warmup', bpm: 0, target: this.heart.target };
    this._t = 0;
  }

  update(elapsed, { hr = 0 } = {}) {
    const t = Math.max(0, elapsed);
    this._t = t;
    if (t >= this.total) {
      const finishedNow = !this.done;
      this.done = true;
      return { done: true, finishedNow, apply: null, index: this.steps.length - 1, progress: 1, total: this.total, elapsed: this.total };
    }
    let index = this.steps.findIndex((s) => t < s.start + s.seconds);
    if (index < this.index) index = this.index; // never step backwards if time jitters
    const entered = index !== this.index;
    this.index = index;
    const current = this.steps[index];
    let apply = null;

    if (index === this.holdIndex) {
      if (entered) this.controller.restart(t);
      const before = this.set[this.key];
      this.status = this.controller.update({ t, hr, value: before });
      if (this.status.value !== before) {
        this.set[this.key] = this.status.value;
        apply = { label: current.label, ...this.set, quiet: true, direction: Math.sign(this.status.value - before) };
      } else if (entered) apply = { label: current.label, ...this.set };
    } else {
      this.status = { action: index < this.holdIndex ? 'warmup' : 'cooldown', bpm: Math.round(hr), target: this.heart.target };
      if (entered) {
        // Warm up at the walking speed; cool down no faster than that, on the flat.
        this.set = { kph: index > this.holdIndex ? Math.min(this.set.kph, this.walk) : this.walk, incline: this.flat };
        apply = { label: current.label, ...this.set };
      }
    }

    const remaining = Math.max(0, current.start + current.seconds - t);
    return {
      done: false,
      finishedNow: false,
      apply,
      index,
      step: current,
      next: this.steps[index + 1] ?? null,
      remaining,
      countdown: remaining <= 3 ? Math.ceil(remaining) : 0,
      progress: t / this.total,
      total: this.total,
      elapsed: t,
      heart: this.status,
    };
  }

  /** The user changed speed or incline by hand: carry on from their setting. */
  manual(name, value) {
    this.set[name === 'Kph' ? 'kph' : 'incline'] = value;
    this.controller.touch(this._t);
  }

  /** After a pause the pulse has dropped: read it afresh before adjusting again. */
  resume() {
    this.controller.restart(this._t);
  }

  /** What the treadmill should be set to now (used to restore it after a pause). */
  get current() {
    return { label: this.steps[Math.max(0, this.index)]?.label ?? '', ...this.set };
  }
}
