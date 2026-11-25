// Draws the post-workout report as two 1080 x 1350 images (canvas), in the app's HUD style.
// Page 1: the workout. Page 2: heart-rate zones, VO2 max and energy (needs a profile).

import { FITNESS_LABELS, ZONE_DEFS, fitnessBounds } from './fitness.js';
import { formatClock } from './programs.js';
import { drawChart } from './hud.js';

const W = 1080, H = 1350, M = 54;
const KM_PER_MILE = 1.609344;
const C = {
  bg: '#050c0e',
  line: 'rgba(63,224,208,0.3)',
  strong: 'rgba(63,224,208,0.75)',
  text: '#d6f5f1',
  bright: '#f1fffd',
  muted: '#6aa39e',
  accent: '#3fe0d0',
  go: '#4ade80',
  warn: '#f5b942',
  heart: '#ff6b6b',
};
const SANS = '"Segoe UI", Roboto, system-ui, sans-serif';
const MONO = 'ui-monospace, "Roboto Mono", Consolas, monospace';

function text(ctx, str, x, y, { size = 24, color = C.text, align = 'left', weight = 400, font = SANS, spacing = 0 } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  try {
    ctx.letterSpacing = `${spacing}px`;
  } catch {
    /* older browsers: no letter spacing */
  }
  // Letter spacing adds a trailing gap; nudge so centred and right-aligned text stays put.
  const shift = spacing ? (align === 'center' ? spacing / 2 : align === 'right' ? spacing : 0) : 0;
  ctx.fillText(str, x + shift, y);
}

const label = (ctx, str, x, y, opts = {}) => text(ctx, String(str).toUpperCase(), x, y, { size: 21, color: C.muted, weight: 600, font: MONO, spacing: 4, ...opts });

function panel(ctx, x, y, w, h, title, right) {
  const fill = ctx.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, 'rgba(48,140,132,0.16)');
  fill.addColorStop(1, 'rgba(20,66,64,0.07)');
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.strokeStyle = C.strong;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y + 26);
  ctx.lineTo(x, y);
  ctx.lineTo(x + 26, y);
  ctx.moveTo(x + w, y + h - 26);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - 26, y + h);
  ctx.stroke();
  if (title) label(ctx, title, x + 26, y + 46);
  if (right) label(ctx, right, x + w - 26, y + 46, { align: 'right', color: C.accent });
}

function page(titleText, summary) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.75);
  glow.addColorStop(0, 'rgba(30,110,105,0.38)');
  glow.addColorStop(1, 'rgba(30,110,105,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(63,224,208,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 54) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 0; y <= H; y += 54) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();

  // Header: ring mark, app name, date.
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(M + 26, 96, 24, 0.5, Math.PI * 2 - 0.5);
  ctx.stroke();
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.arc(M + 26, 96, 11, 0, Math.PI * 2);
  ctx.fill();
  text(ctx, 'CARBON TLX', M + 72, 106, { size: 27, color: C.accent, weight: 500, spacing: 9 });
  const date = new Date(summary.date);
  label(ctx, date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), W - M, 92, { align: 'right' });
  label(ctx, date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), W - M, 122, { align: 'right', color: C.text });
  text(ctx, titleText.toUpperCase(), M, 232, { size: 58, color: C.bright, weight: 300, spacing: 12 });
  ctx.fillStyle = C.accent;
  ctx.fillRect(M, 256, 120, 4);
  label(ctx, 'Estimates from treadmill and heart-rate data · not medical advice', W / 2, H - 40, { align: 'center', size: 18, spacing: 2 });
  return { canvas, ctx };
}

function cells(ctx, x, y, w, h, items, { valueSize = 54, cols = items.length } = {}) {
  const rows = Math.ceil(items.length / cols);
  const cw = w / cols, ch = h / rows;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  items.forEach(([value, name, color], i) => {
    const cx = x + (i % cols) * cw, cy = y + Math.floor(i / cols) * ch;
    if (i % cols) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + 16);
      ctx.lineTo(cx, cy + ch - 16);
      ctx.stroke();
    }
    if (i >= cols && i % cols === 0) {
      ctx.beginPath();
      ctx.moveTo(x + 16, cy);
      ctx.lineTo(x + w - 16, cy);
      ctx.stroke();
    }
    text(ctx, String(value), cx + cw / 2, cy + ch / 2 + valueSize * 0.22, { size: valueSize, color: color ?? C.bright, weight: 300, align: 'center' });
    label(ctx, name, cx + cw / 2, cy + ch / 2 + valueSize * 0.22 + 38, { align: 'center', size: 19 });
  });
}

function workoutPage(summary, { imperial }) {
  const { canvas, ctx } = page('Workout report', summary);
  const speed = (kph) => (imperial ? kph / KM_PER_MILE : kph);
  const unit = imperial ? 'mph' : 'km/h';
  const dist = imperial ? 'mi' : 'km';
  const km = summary.metres / 1000;
  const kcal = summary.report?.kcal || summary.kcal;
  const pace = summary.avgKph >= 0.5 ? formatClock(3600 / speed(summary.avgKph)) : '--';

  panel(ctx, M, 300, W - 2 * M, 230);
  cells(ctx, M, 300, W - 2 * M, 230, [
    [formatClock(summary.seconds), 'Time'],
    [(imperial ? km / KM_PER_MILE : km).toFixed(2), `Distance ${dist}`],
    [kcal, 'Kcal'],
  ], { valueSize: 96 });

  panel(ctx, M, 554, W - 2 * M, 260);
  cells(ctx, M, 554, W - 2 * M, 260, [
    [speed(summary.avgKph).toFixed(1), `Avg ${unit}`],
    [speed(summary.maxKph).toFixed(1), `Max ${unit}`],
    [pace, `Pace /${dist}`],
    [Math.round(summary.elevation), 'Climb m'],
    [summary.avgHr || '--', 'Avg bpm', summary.avgHr ? C.heart : C.muted],
    [summary.maxHr || '--', 'Max bpm', summary.maxHr ? C.heart : C.muted],
  ], { valueSize: 56, cols: 3 });

  const top = 838, height = H - 90 - top;
  panel(ctx, M, top, W - 2 * M, height, 'Speed · incline · heart rate');
  const chart = document.createElement('canvas');
  const cw = W - 2 * M - 40, ch = height - 90;
  drawChart(chart, summary.series ?? [], {
    maxKph: Math.max(summary.maxKph, 8),
    maxIncline: 12,
    toSpeed: speed,
    size: { w: cw / 2, h: ch / 2, dpr: 2 },
  });
  if (chart.width) ctx.drawImage(chart, M + 20, top + 66, cw, ch);
  return canvas;
}

function fitnessPage(summary, { profile }) {
  const { canvas, ctx } = page('Heart & fitness', summary);
  const r = summary.report;
  const inner = W - 2 * M;

  // ----- VO2 max -----
  panel(ctx, M, 300, inner, 318, 'VO2 max · estimate');
  text(ctx, r.vo2max.toFixed(1), M + 34, 462, { size: 124, color: C.bright, weight: 300 });
  label(ctx, 'ml / kg / min', M + 40, 502);
  const levelColors = ['#7aa2b8', C.warn, C.go, C.accent, '#b79cff'];
  text(ctx, FITNESS_LABELS[r.fitness].toUpperCase(), W - M - 34, 430, { size: 56, color: levelColors[r.fitness], weight: 400, align: 'right', spacing: 6 });
  label(ctx, 'for your age and sex', W - M - 34, 468, { align: 'right', size: 18 });
  // scale
  const bounds = fitnessBounds(profile);
  const edges = [bounds[0] - 10, ...bounds, bounds[3] + 10];
  const sx = M + 34, sw = inner - 68, sy = 536, seg = sw / 5;
  FITNESS_LABELS.forEach((name, i) => {
    ctx.globalAlpha = i === r.fitness ? 1 : 0.35;
    ctx.fillStyle = levelColors[i];
    ctx.fillRect(sx + i * seg + 3, sy, seg - 6, 12);
    ctx.globalAlpha = 1;
    label(ctx, name, sx + i * seg + seg / 2, sy + 44, { align: 'center', size: 16, spacing: 2, color: i === r.fitness ? C.text : C.muted });
  });
  const within = Math.min(1, Math.max(0, (r.vo2max - edges[r.fitness]) / (edges[r.fitness + 1] - edges[r.fitness])));
  const mx = sx + (r.fitness + within) * seg;
  ctx.fillStyle = C.bright;
  ctx.beginPath();
  ctx.moveTo(mx, sy - 4);
  ctx.lineTo(mx - 11, sy - 22);
  ctx.lineTo(mx + 11, sy - 22);
  ctx.closePath();
  ctx.fill();
  label(ctx, r.vo2Source === 'session' ? 'Measured from heart rate at steady pace in this workout' : 'From your profile only · run steady with a heart strap to refine', M + 34, 604, { size: 16, spacing: 2 });

  // ----- zones -----
  const zy = 642, zh = 430;
  panel(ctx, M, zy, inner, zh, 'Heart rate zones', `Max ${r.maxHr} bpm`);
  const tracked = r.hrTracked;
  const longest = Math.max(1, ...r.zoneSeconds.slice(1));
  const rowH = 66, barX = M + 470, barW = inner - 470 - 190;
  [...ZONE_DEFS].reverse().forEach((def, i) => {
    const y = zy + 78 + i * rowH;
    const zone = r.zones.find((z) => z.id === def.id);
    const sec = r.zoneSeconds[def.id];
    ctx.fillStyle = def.color;
    ctx.globalAlpha = tracked ? 1 : 0.6;
    ctx.fillRect(M + 26, y, 64, 44);
    ctx.globalAlpha = 1;
    text(ctx, `Z${def.id}`, M + 58, y + 32, { size: 26, color: '#04181a', weight: 700, align: 'center' });
    text(ctx, def.name.toUpperCase(), M + 110, y + 22, { size: 25, color: def.id === 2 ? C.go : C.text, weight: 600, spacing: 3 });
    label(ctx, `${zone.from}–${zone.to} bpm`, M + 110, y + 48, { size: 17, spacing: 2 });
    ctx.fillStyle = 'rgba(63,224,208,0.1)';
    ctx.fillRect(barX, y + 10, barW, 24);
    if (sec > 0) {
      ctx.fillStyle = def.color;
      ctx.shadowColor = def.color;
      ctx.shadowBlur = 14;
      ctx.fillRect(barX, y + 10, Math.max(4, (sec / longest) * barW), 24);
      ctx.shadowBlur = 0;
    }
    text(ctx, tracked ? formatClock(sec) : '--', W - M - 100, y + 32, { size: 30, color: sec ? C.bright : C.muted, weight: 400, align: 'right', font: MONO });
    label(ctx, tracked ? `${Math.round((sec / tracked) * 100)}%` : '', W - M - 26, y + 31, { align: 'right', size: 19, spacing: 1 });
  });
  if (!tracked) label(ctx, 'No heart-rate data in this workout · link a strap to fill these in', W / 2, zy + zh - 16, { align: 'center', size: 16, spacing: 2, color: C.warn });
  else if (r.zoneSeconds[0] > 0) label(ctx, `Below zone 1: ${formatClock(r.zoneSeconds[0])}`, W - M - 26, zy + zh - 16, { align: 'right', size: 16, spacing: 2 });

  // ----- energy -----
  panel(ctx, M, 1096, inner, 164);
  cells(ctx, M, 1096, inner, 164, [
    [r.kcal || summary.kcal, 'Kcal for your weight'],
    [r.fatGrams.toFixed(1), 'Fat burned g · est.', C.go],
    [tracked ? formatClock(r.zoneSeconds[2]) : '--', 'Time in fat burn', tracked ? C.go : C.muted],
  ], { valueSize: 56 });
  return canvas;
}

/** Returns one canvas (no profile) or two. `summary.report` comes from fitness.buildReport. */
export function renderReport(summary, { imperial = false, profile = null } = {}) {
  const pages = [workoutPage(summary, { imperial })];
  if (profile && summary.report) pages.push(fitnessPage(summary, { profile }));
  return pages;
}

/** PNG files for sharing or saving. */
export function reportFiles(pages, date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return Promise.all(
    pages.map(
      (canvas, i) =>
        new Promise((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(new File([blob], `carbon-tlx-${stamp}-${i + 1}.png`, { type: 'image/png' })) : reject(new Error('could not create image'))), 'image/png'),
        ),
    ),
  );
}
