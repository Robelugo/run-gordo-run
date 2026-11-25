// Small presentation helpers for the HUD: ring gauges, tweened numbers,
// the session chart, program profile sketches, beeps and haptics.

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Ring gauge: `arc` is the value circle, `marker` the target dot group. */
export function setGauge(arc, marker, value, target, max) {
  const frac = Math.min(1, Math.max(0, max > 0 ? value / max : 0));
  arc.style.strokeDasharray = `${(75 * frac).toFixed(2)} 100`;
  if (marker) {
    const t = Math.min(1, Math.max(0, max > 0 ? target / max : 0));
    marker.style.transform = `rotate(${-135 + 270 * t}deg)`;
    marker.style.opacity = target > 0 ? 1 : 0;
  }
}

const tweens = new WeakMap();

/** Animate a number in an element towards `value`. */
export function tweenNumber(el, value, decimals = 1, ms = 350) {
  const state = tweens.get(el) ?? { shown: value, frame: 0 };
  tweens.set(el, state);
  cancelAnimationFrame(state.frame);
  if (reduceMotion() || Math.abs(value - state.shown) < 10 ** -decimals / 2) {
    state.shown = value;
    el.textContent = value.toFixed(decimals);
    return;
  }
  const from = state.shown;
  const start = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - k) ** 3;
    state.shown = from + (value - from) * eased;
    el.textContent = state.shown.toFixed(decimals);
    if (k < 1) state.frame = requestAnimationFrame(tick);
  };
  state.frame = requestAnimationFrame(tick);
}

/**
 * Draw speed (line + glow) and incline (steps) over time.
 * `points` is an array of [seconds, kph, incline, bpm?]; speeds are shown via `toSpeed`.
 * Heart rate, when present, is drawn on its own 40-200 bpm scale.
 */
export function drawChart(canvas, points, { maxKph = 16, maxIncline = 12, toSpeed = (v) => v, colors, size } = {}) {
  const dpr = size?.dpr ?? Math.min(2, window.devicePixelRatio || 1);
  const w = size?.w ?? canvas.clientWidth, h = size?.h ?? canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const c = { line: '#3fe0d0', incline: '#4ade80', grid: 'rgba(63,224,208,0.13)', text: 'rgba(160,220,214,0.65)', ...colors };
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 26, r: 8, t: 8, b: 16 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const top = Math.max(4, Math.ceil((toSpeed(maxKph) + 0.01) / 4) * 4);
  const tMax = Math.max(60, points.length ? points[points.length - 1][0] : 0);
  const X = (t) => pad.l + (t / tMax) * iw;
  const Y = (v) => pad.t + ih - (v / top) * ih;
  const YI = (i) => pad.t + ih - (Math.max(0, i) / Math.max(1, maxIncline)) * ih * 0.5;

  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = (top / 4) * g, y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = c.grid;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = c.text;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), pad.l - 5, y);
  }
  const minutes = tMax / 60;
  const every = minutes <= 6 ? 1 : minutes <= 15 ? 3 : minutes <= 40 ? 10 : 20;
  ctx.textAlign = 'center';
  for (let m = 0; m <= minutes; m += every) {
    const x = Math.round(X(m * 60)) + 0.5;
    ctx.strokeStyle = c.grid;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ih);
    ctx.stroke();
    ctx.fillStyle = c.text;
    ctx.fillText(`${m}'`, x, h - 6);
  }
  if (points.length < 2) {
    ctx.fillStyle = c.text;
    ctx.textAlign = 'center';
    ctx.fillText('NO DATA YET', pad.l + iw / 2, pad.t + ih / 2);
    return;
  }

  // Incline as a stepped line.
  ctx.strokeStyle = c.incline;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  points.forEach(([t, , inc], i) => {
    if (i === 0) ctx.moveTo(X(t), YI(inc));
    else {
      ctx.lineTo(X(t), YI(points[i - 1][2]));
      ctx.lineTo(X(t), YI(inc));
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Heart rate on a fixed 40-200 bpm scale.
  if (points.some((p) => p[3] > 0)) {
    const YH = (bpm) => pad.t + ih - (Math.min(160, Math.max(0, bpm - 40)) / 160) * ih;
    ctx.strokeStyle = c.heart ?? '#ff6b6b';
    ctx.lineWidth = 1.25;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let pen = false;
    for (const [t, , , bpm] of points) {
      if (!(bpm > 0)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(X(t), YH(bpm));
      else ctx.moveTo(X(t), YH(bpm));
      pen = true;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Speed: filled area, glowing line, marker on the newest point.
  const path = () => {
    ctx.beginPath();
    points.forEach(([t, kph], i) => (i ? ctx.lineTo(X(t), Y(toSpeed(kph))) : ctx.moveTo(X(t), Y(toSpeed(kph)))));
  };
  path();
  ctx.lineTo(X(points[points.length - 1][0]), pad.t + ih);
  ctx.lineTo(X(points[0][0]), pad.t + ih);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
  fill.addColorStop(0, 'rgba(63,224,208,0.28)');
  fill.addColorStop(1, 'rgba(63,224,208,0)');
  ctx.fillStyle = fill;
  ctx.fill();
  path();
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.shadowColor = c.line;
  ctx.shadowBlur = 8;
  ctx.stroke();
  const [lt, lk] = points[points.length - 1];
  ctx.fillStyle = '#eafffb';
  ctx.beginPath();
  ctx.arc(X(lt), Y(toSpeed(lk)), 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

/** Tiny bar sketch of a program: one bar per step, width by time, height by speed. */
export function profileSvg(steps, width = 120, height = 28) {
  const total = steps.reduce((s, x) => s + x.seconds, 0) || 1;
  const top = Math.max(...steps.map((s) => s.kph), 1);
  let x = 0;
  const bars = steps
    .map((s) => {
      const w = (s.seconds / total) * width;
      const h = Math.max(2, (s.kph / top) * (height - 6));
      const hill = s.incline > 0 ? `<rect x="${(x + 0.5).toFixed(1)}" y="0" width="${Math.max(0.5, w - 1).toFixed(1)}" height="${Math.min(5, s.incline / 2).toFixed(1)}" class="hill"/>` : '';
      const bar = `<rect x="${(x + 0.5).toFixed(1)}" y="${(height - h).toFixed(1)}" width="${Math.max(0.5, w - 1).toFixed(1)}" height="${h.toFixed(1)}"/>${hill}`;
      x += w;
      return bar;
    })
    .join('');
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

let audio = null;

/** Short tone; silently does nothing where audio is unavailable or not yet unlocked. */
export function beep(freq = 880, ms = 120, volume = 0.12) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000 + 0.02);
  } catch {
    /* no audio */
  }
}

export function buzz(pattern = 12) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* no haptics */
  }
}
