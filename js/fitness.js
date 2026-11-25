// Fitness estimates from a personal profile and workout data. Pure maths, no DOM.
// Everything here is a population-formula estimate, not a measurement.
//
// profile = { sex: 'male' | 'female' | 'other', age, weightKg, heightCm,
//             restHr?, maxHr?, activity? (0-7 physical activity rating) }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function isCompleteProfile(p) {
  return !!p && ['male', 'female', 'other'].includes(p.sex) && p.age >= 10 && p.age <= 100 && p.weightKg >= 25 && p.weightKg <= 300 && p.heightCm >= 100 && p.heightCm <= 250;
}

/** 1 for male, 0 for female, halfway when unspecified (the formulas only know two values). */
const sexFactor = (p) => (p.sex === 'male' ? 1 : p.sex === 'female' ? 0 : 0.5);

/** Maximum heart rate: the user's own value if given, else Tanaka (208 - 0.7 x age). */
export const maxHeartRate = (p) => Math.round(p.maxHr > 0 ? p.maxHr : 208 - 0.7 * p.age);

export const restingHeartRate = (p) => Math.round(p.restHr > 0 ? p.restHr : 65);

export const ZONE_DEFS = [
  { id: 1, name: 'Recovery', note: 'warm-up, very easy', lo: 0.5, hi: 0.6, color: '#7aa2b8' },
  { id: 2, name: 'Fat burn', note: 'easy endurance', lo: 0.6, hi: 0.7, color: '#4ade80' },
  { id: 3, name: 'Aerobic', note: 'steady cardio', lo: 0.7, hi: 0.8, color: '#3fe0d0' },
  { id: 4, name: 'Threshold', note: 'hard, sustainable', lo: 0.8, hi: 0.9, color: '#f5b942' },
  { id: 5, name: 'Maximum', note: 'all-out', lo: 0.9, hi: 1.0, color: '#ff4d4d' },
];

/**
 * Five heart-rate zones as bpm ranges. With a known resting heart rate they are
 * taken from heart-rate reserve (Karvonen); otherwise as a share of maximum.
 */
export function heartZones(p) {
  const max = maxHeartRate(p);
  const useReserve = p.restHr > 0;
  const rest = restingHeartRate(p);
  const at = (frac) => Math.round(useReserve ? rest + frac * (max - rest) : frac * max);
  return ZONE_DEFS.map((z) => ({ ...z, from: at(z.lo), to: z.id === 5 ? max : at(z.hi) - 1 }));
}

/** Zone number 1-5 for a heart rate, or 0 below zone 1. Above max counts as zone 5. */
export function zoneOf(zones, bpm) {
  if (!(bpm > 0) || bpm < zones[0].from) return 0;
  for (let i = zones.length - 1; i >= 0; i--) if (bpm >= zones[i].from) return zones[i].id;
  return 0;
}

/**
 * Oxygen cost of treadmill walking/running, ml/kg/min (ACSM metabolic equations).
 * Walking and running use different equations; between 6 and 8 km/h they are blended
 * so the estimate does not jump when the speed crosses the boundary.
 */
export function oxygenCost(kph, inclinePct = 0) {
  if (!(kph > 0.3)) return 3.5;
  const s = (kph * 1000) / 60; // metres per minute
  const g = Math.max(0, inclinePct) / 100;
  const walk = 3.5 + 0.1 * s + 1.8 * s * g;
  const run = 3.5 + 0.2 * s + 0.9 * s * g;
  const t = clamp((kph - 6) / 2, 0, 1);
  return walk + (run - walk) * t;
}

/** Flat-belt speed (km/h) that costs about `vo2` ml/kg/min. */
export function speedForOxygen(vo2) {
  let lo = 0.5, hi = 30;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (oxygenCost(mid, 0) < vo2) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}

export const bmi = (p) => p.weightKg / (p.heightCm / 100) ** 2;

export function bmiLabel(value) {
  return value < 18.5 ? 'Underweight' : value < 25 ? 'Healthy range' : value < 30 ? 'Overweight' : 'Obese range';
}

/** Resting energy use per day, kcal (Mifflin-St Jeor). */
export const bmr = (p) => Math.round(10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (sexFactor(p) * 166 - 161));

export const ACTIVITY_LEVELS = [
  { value: 1, label: 'Mostly sitting' },
  { value: 3, label: 'Light activity' },
  { value: 5, label: 'Regular exercise' },
  { value: 6, label: 'Run 15-30 km a week' },
  { value: 7, label: 'Run over 30 km a week' },
];

/** VO2 max without any exercise data (Jackson non-exercise model, BMI version). */
export function vo2maxFromProfile(p) {
  const rating = p.activity >= 0 ? p.activity : 3;
  return clamp(56.363 + 1.921 * rating - 0.381 * p.age - 0.754 * bmi(p) + 10.987 * sexFactor(p), 15, 80);
}

/**
 * VO2 max from a workout: at a steady pace, the share of heart-rate reserve in use
 * roughly equals the share of oxygen-uptake reserve in use, so a submaximal reading
 * can be scaled up to the maximum. Uses only steady stretches at a moderate-to-hard
 * heart rate; returns null when there is not enough of that.
 * `samples` are { t, kph, incline, hr } taken every couple of seconds.
 */
export function vo2maxFromSamples(samples, p) {
  const max = maxHeartRate(p), rest = restingHeartRate(p);
  const estimates = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.t < 180 || !(s.hr > 0) || s.kph < 3) continue;
    const reserve = (s.hr - rest) / (max - rest);
    if (reserve < 0.45 || reserve > 0.92) continue;
    // steady for the last 90 seconds?
    let steady = true, covered = false;
    for (let j = i - 1; j >= 0; j--) {
      const q = samples[j];
      if (s.t - q.t > 90) {
        covered = true;
        break;
      }
      if (Math.abs(q.kph - s.kph) > 0.35 || Math.abs(q.incline - s.incline) > 0.6) {
        steady = false;
        break;
      }
    }
    if (!steady || !covered) continue;
    estimates.push(3.5 + (oxygenCost(s.kph, s.incline) - 3.5) / reserve);
  }
  if (estimates.length < 15) return null;
  estimates.sort((a, b) => a - b);
  return clamp(estimates[Math.floor(estimates.length / 2)], 15, 85);
}

// Lower bounds of Fair, Good, Excellent, Superior by age decade (widely used
// reference ranges for VO2 max in ml/kg/min; below "Fair" is "Low").
const NORMS = {
  male: [[36.5, 42.5, 46.5, 52.5], [35.5, 41.0, 45.0, 49.5], [33.6, 39.0, 43.8, 48.1], [31.0, 35.8, 41.0, 45.4], [26.1, 32.3, 36.5, 44.3]],
  female: [[29.0, 33.0, 37.0, 41.1], [27.0, 31.5, 35.7, 40.1], [24.5, 29.0, 32.9, 37.0], [22.8, 27.0, 31.5, 35.8], [20.2, 24.5, 30.3, 31.5]],
};
export const FITNESS_LABELS = ['Low', 'Fair', 'Good', 'Excellent', 'Superior'];

export function fitnessBounds(p) {
  const row = clamp(Math.floor((p.age - 20) / 10), 0, 4);
  if (p.sex === 'male' || p.sex === 'female') return NORMS[p.sex][row];
  return NORMS.male[row].map((m, i) => (m + NORMS.female[row][i]) / 2);
}

/** 0-4 index into FITNESS_LABELS. */
export function fitnessLevel(vo2, p) {
  return fitnessBounds(p).filter((bound) => vo2 >= bound).length;
}

/** Rough share of energy coming from fat at each zone (0 = below zone 1). */
const FAT_SHARE = [0.65, 0.6, 0.5, 0.35, 0.2, 0.1];

/**
 * Everything the post-workout report needs beyond the plain totals.
 * `data` = { seconds, o2PerKg (ml/kg used in total), hrSeconds (seconds spent at each bpm), samples }
 */
export function buildReport(data, p) {
  const zones = heartZones(p);
  const zoneSeconds = [0, 0, 0, 0, 0, 0];
  let tracked = 0;
  (data.hrSeconds ?? []).forEach((sec, bpm) => {
    if (!sec) return;
    zoneSeconds[zoneOf(zones, bpm)] += sec;
    tracked += sec;
  });
  const kcal = ((data.o2PerKg ?? 0) * p.weightKg * 5) / 1000; // about 5 kcal per litre of oxygen
  // Fat share follows time in zone when the heart rate was tracked, else assume easy-to-steady effort.
  const fatShare = tracked > 30 ? zoneSeconds.reduce((sum, sec, zone) => sum + (sec / tracked) * FAT_SHARE[zone], 0) : 0.45;
  const fromSession = vo2maxFromSamples(data.samples ?? [], p);
  const vo2max = fromSession ?? vo2maxFromProfile(p);
  const mainZone = tracked > 30 ? zoneSeconds.indexOf(Math.max(...zoneSeconds)) : null;
  return {
    kcal: Math.round(kcal),
    fatGrams: Math.round(((kcal * fatShare) / 9) * 10) / 10,
    zoneSeconds: zoneSeconds.map(Math.round),
    hrTracked: Math.round(tracked),
    mainZone,
    vo2max: Math.round(vo2max * 10) / 10,
    vo2Source: fromSession ? 'session' : 'profile',
    fitness: fitnessLevel(vo2max, p),
    maxHr: maxHeartRate(p),
    zones: zones.map((z) => ({ id: z.id, from: z.from, to: z.to })),
  };
}

/**
 * Speeds (km/h, flat belt) that should land in each heart-rate zone for this person:
 * each zone's bpm limits are turned into a share of heart-rate reserve, which is
 * about the same share of oxygen-uptake reserve, and then into a speed.
 */
export function zoneSpeeds(vo2max, p) {
  const max = maxHeartRate(p), rest = restingHeartRate(p);
  const speedAt = (bpm) => speedForOxygen(3.5 + clamp((bpm - rest) / (max - rest), 0.05, 1) * (vo2max - 3.5));
  return heartZones(p).map((z) => ({ id: z.id, from: speedAt(z.from), to: speedAt(z.to + 1) }));
}
