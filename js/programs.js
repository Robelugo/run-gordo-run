// Workout programs: timed steps that set speed and incline automatically.
// Pure logic (no DOM, no Bluetooth) so it is covered by the Node tests.

/** Default speeds (km/h) the presets are built from; the user can change them. */
export const DEFAULT_LEVELS = { walk: 4.5, jog: 7, run: 10 };

const step = (label, seconds, level, incline = 0) => ({ label, seconds, level, incline });
const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i)).flat();

export const PRESETS = [
  {
    id: 'intervals',
    name: 'Intervals',
    blurb: '6 x 2 min run / 1 min walk',
    steps: [
      step('Warm-up', 300, 'walk'),
      ...repeat(6, (i) => [step(`Run ${i + 1}/6`, 120, 'run'), step('Recover', 60, 'walk')]),
      step('Cool-down', 240, 'walk'),
    ],
  },
  {
    id: 'hiit',
    name: 'Quick HIIT',
    blurb: '8 x 30 s sprint / 30 s walk',
    steps: [
      step('Warm-up', 180, 'walk'),
      step('Build', 60, 'jog'),
      ...repeat(8, (i) => [step(`Sprint ${i + 1}/8`, 30, 'run'), step('Recover', 30, 'walk')]),
      step('Cool-down', 180, 'walk'),
    ],
  },
  {
    id: 'hills',
    name: 'Hill climb',
    blurb: 'Walk up to 8 % and back',
    steps: [0, 2, 4, 6, 8, 6, 4, 2, 0].map((incline, i, all) =>
      step(i === 0 ? 'Warm-up' : i === all.length - 1 ? 'Cool-down' : `Hill ${incline} %`, 180, 'walk', incline),
    ),
  },
  {
    id: 'steady',
    name: 'Steady 30',
    blurb: '24 min jog with warm-up and cool-down',
    steps: [step('Warm-up', 180, 'walk'), step('Steady jog', 1440, 'jog'), step('Cool-down', 180, 'walk')],
  },
  {
    id: 'pyramid',
    name: 'Pyramid',
    blurb: 'Runs of 1, 2, 3, 2, 1 min',
    steps: [
      step('Warm-up', 240, 'walk'),
      ...[1, 2, 3, 2, 1].flatMap((min, i) => [step(`Run ${min} min`, min * 60, 'run'), step('Jog', i === 4 ? 60 : 120, 'jog')]),
      step('Cool-down', 240, 'walk'),
    ],
  },
];

/** Custom interval workout from a handful of numbers. */
export function buildIntervals({ warmupMin = 5, workSec = 60, restSec = 60, repeats = 6, cooldownMin = 3, workIncline = 0 } = {}) {
  const n = Math.max(1, Math.min(40, Math.round(repeats)));
  return {
    id: 'custom',
    name: 'Custom intervals',
    blurb: `${n} x ${formatClock(workSec)} / ${formatClock(restSec)}`,
    steps: [
      ...(warmupMin > 0 ? [step('Warm-up', Math.round(warmupMin * 60), 'walk')] : []),
      ...repeat(n, (i) => [
        step(`Work ${i + 1}/${n}`, Math.max(5, Math.round(workSec)), 'run', workIncline),
        ...(restSec > 0 ? [step('Recover', Math.round(restSec), 'walk')] : []),
      ]),
      ...(cooldownMin > 0 ? [step('Cool-down', Math.round(cooldownMin * 60), 'walk')] : []),
    ],
  };
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const totalSeconds = (program) => program.steps.reduce((sum, s) => sum + s.seconds, 0);

/**
 * Turn a program's named levels into real speeds, clamped to what the treadmill allows.
 * Returns steps of { label, seconds, kph, incline, start }.
 */
export function resolve(program, levels = DEFAULT_LEVELS, limits = {}) {
  const { minKph = 1, maxKph = 20, minIncline = 0, maxIncline = 12 } = limits;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let start = 0;
  return program.steps.map((s) => {
    const kph = typeof s.level === 'number' ? s.level : (levels[s.level] ?? DEFAULT_LEVELS[s.level] ?? DEFAULT_LEVELS.walk);
    const out = {
      label: s.label,
      seconds: s.seconds,
      kph: Math.round(clamp(kph, minKph, maxKph) * 10) / 10,
      incline: Math.round(clamp(s.incline ?? 0, minIncline, maxIncline) * 2) / 2,
      start,
    };
    start += s.seconds;
    return out;
  });
}

/**
 * Follows a resolved program against workout time.
 * Call update(elapsedSeconds) regularly; it reports where the workout is and
 * `apply` holds a step exactly once, at the moment its speed/incline should be sent.
 */
export class ProgramRunner {
  constructor(program, levels, limits) {
    this.program = program;
    this.steps = resolve(program, levels, limits);
    this.total = this.steps.reduce((sum, s) => sum + s.seconds, 0);
    this.index = -1;
    this.done = false;
  }

  update(elapsed) {
    const t = Math.max(0, elapsed);
    if (t >= this.total) {
      const finishedNow = !this.done;
      this.done = true;
      return { done: true, finishedNow, apply: null, index: this.steps.length - 1, progress: 1, total: this.total, elapsed: this.total };
    }
    let index = this.steps.findIndex((s) => t < s.start + s.seconds);
    if (index < this.index) index = this.index; // never step backwards if time jitters
    const current = this.steps[index];
    const apply = index !== this.index ? current : null;
    this.index = index;
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
    };
  }

  /** The step that should be active now (used to restore speed after a pause). */
  get current() {
    return this.steps[Math.max(0, this.index)] ?? null;
  }
}
