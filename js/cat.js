// A small procedural 3D cat running on a treadmill belt, drawn with raw WebGL.
// No models or libraries: the cat is built from ellipsoids, cones and boxes and
// animated with a speed-dependent gait (walk -> trot -> gallop).
//
//   const cat = new CatScene(canvas);
//   cat.setSpeed(kph); cat.setIncline(percent); cat.start();

// ---------- tiny matrix library (column-major 4x4) ----------

const ident = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

const tr = (m, x, y, z) => mul(m, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]));
const sc = (m, x, y, z) => mul(m, new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]));
const rz = (m, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return mul(m, new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
};
const ry = (m, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return mul(m, new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]));
};
const rx = (m, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return mul(m, new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]));
};

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const o = new Float32Array(16);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}

function lookAt(eye, at, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(...a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

/** Inverse-transpose of the upper 3x3, so normals survive non-uniform scaling. */
function normalMatrix(m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return new Float32Array([
    A / det, B / det, C / det,
    (c * h - b * i) / det, (a * i - c * g) / det, (b * g - a * h) / det,
    (b * f - c * e) / det, (c * d - a * f) / det, (a * e - b * d) / det,
  ]);
}

// ---------- geometry (interleaved position + normal, plain triangles) ----------

function sphereMesh(lat = 14, lon = 22) {
  const v = [];
  const p = (i, j) => {
    const t = (i / lat) * Math.PI, f = (j / lon) * Math.PI * 2;
    const x = Math.sin(t) * Math.cos(f), y = Math.cos(t), z = Math.sin(t) * Math.sin(f);
    return [x, y, z, x, y, z];
  };
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      v.push(...p(i, j), ...p(i + 1, j), ...p(i + 1, j + 1), ...p(i, j), ...p(i + 1, j + 1), ...p(i, j + 1));
    }
  }
  return new Float32Array(v);
}

function boxMesh() {
  const v = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, w] of faces) {
    const corner = (a, b) => [n[0] + a * u[0] + b * w[0], n[1] + a * u[1] + b * w[1], n[2] + a * u[2] + b * w[2], ...n];
    v.push(...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, -1), ...corner(1, 1), ...corner(-1, 1));
  }
  return new Float32Array(v);
}

/** Cone with its base (radius 1) at y=0 and tip at y=1. */
function coneMesh(seg = 18) {
  const v = [];
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * Math.PI * 2, b = ((j + 1) / seg) * Math.PI * 2, m = (a + b) / 2;
    const k = Math.SQRT1_2;
    v.push(Math.cos(a), 0, Math.sin(a), Math.cos(a) * k, k, Math.sin(a) * k);
    v.push(0, 1, 0, Math.cos(m) * k, k, Math.sin(m) * k);
    v.push(Math.cos(b), 0, Math.sin(b), Math.cos(b) * k, k, Math.sin(b) * k);
  }
  return new Float32Array(v);
}

const VERT = `
attribute vec3 aPos; attribute vec3 aNormal;
uniform mat4 uViewProj; uniform mat4 uModel; uniform mat3 uNormalMat;
varying vec3 vNormal; varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  gl_Position = uViewProj * w;
}`;

const FRAG = `
precision mediump float;
uniform vec3 uColor; uniform float uAlpha; uniform float uShade; uniform vec3 uEye; uniform vec3 uRim;
uniform float uHolo; uniform float uTime;
varying vec3 vNormal; varying vec3 vWorld;
void main() {
  vec3 n = normalize(vNormal);
  vec3 key = normalize(vec3(0.45, 0.9, 0.55));
  float diff = max(dot(n, key), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 lit = uColor * (0.46 + 0.2 * hemi + 0.55 * diff);
  vec3 v = normalize(uEye - vWorld);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  lit += uRim * rim * 0.22;
  vec3 col = mix(uColor, lit, uShade);
  if (uHolo > 0.5 && uAlpha > 0.99) {
    // Hologram: teal light, bright edges, scan lines drifting upwards.
    float scan = 0.8 + 0.2 * sin(vWorld.y * 42.0 - uTime * 4.0);
    float lum = dot(uColor, vec3(0.3, 0.6, 0.1));
    col = vec3(0.22, 0.9, 0.82) * (0.14 + 0.36 * diff + 1.4 * rim) * scan * (0.45 + 0.85 * lum);
  }
  gl_FragColor = vec4(col * uAlpha, uAlpha);
}`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

export const DEFAULT_VIEW = { yaw: 0.5, pitch: 0.29 };

export const DEFAULT_PALETTE = {
  fur: '#ff9d3c',
  furDark: '#d9641f',
  cream: '#fdebd0',
  pink: '#f48fa0',
  nose: '#f48fa0',
  tailTip: '#fdebd0',
  eye: '#20242c',
  iris: '#e2c64a',
  belt: '#0b1d20',
  beltStripe: '#1f5552',
  frame: '#1d5b58',
  rim: '#3fe0d0',
};

/**
 * The cats to choose from. Shape numbers are multipliers on the base cat:
 * scale (overall size), girth (body thickness), legs (leg length), limb (leg and
 * tail thickness), head, bib (white chest patch). `slant` tilts the eyes.
 */
export const BREEDS = {
  tabby: {
    label: 'Orange tabby',
    scale: 1, girth: 1, legs: 1, limb: 1, head: 1, bib: 1,
    stripes: true, iris: false, slant: 0, rimGain: 1,
    palette: {},
  },
  kitten: {
    label: 'Young tabby',
    scale: 0.8, girth: 0.95, legs: 0.92, limb: 1.05, head: 1.2, bib: 0.9,
    stripes: true, iris: true, slant: 0, rimGain: 0.7,
    palette: { fur: '#8b9199', furDark: '#1f2126', cream: '#cdd2d8', tailTip: '#1f2126', iris: '#b9d44c', rim: '#d5ebe8' },
  },
  tuxedo: {
    label: 'Chubby tuxedo',
    scale: 1.02, girth: 1.34, legs: 0.82, limb: 1.25, head: 1.08, bib: 1.45,
    stripes: false, iris: true, slant: 0, rimGain: 1.5,
    palette: { fur: '#22252d', furDark: '#22252d', cream: '#f4f6f8', tailTip: '#f4f6f8', iris: '#e8c63e', rim: '#93a4b8' },
  },
  white: {
    label: 'Slim white',
    scale: 1, girth: 0.84, legs: 1.1, limb: 0.84, head: 0.95, bib: 1,
    stripes: false, iris: true, slant: 0, rimGain: 0.5,
    palette: { fur: '#e3e6ea', furDark: '#e3e6ea', cream: '#f4f6f8', tailTip: '#e3e6ea', iris: '#2f9dff', rim: '#ffffff' },
  },
  black: {
    label: 'Small black',
    scale: 0.8, girth: 0.82, legs: 1.05, limb: 0.82, head: 1.02, bib: 1,
    stripes: false, iris: true, slant: 0.42, rimGain: 1.7,
    palette: { fur: '#1b1e25', furDark: '#1b1e25', cream: '#22252d', tailTip: '#1b1e25', pink: '#5a4450', nose: '#3a2c34', iris: '#4fe05e', rim: '#8fa0b4' },
  },
};

export class CatScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ok = false;
    this.running = false;
    this.setBreed(options.breed ?? 'tabby');
    this.targetKph = 0;
    this.kph = 0;
    this.targetIncline = 0;
    this.incline = 0;
    this.phase = 0;
    this.belt = 0;
    this.time = 0;
    this.running = false;
    this.holo = false;
    this.yaw = DEFAULT_VIEW.yaw; // camera angle around the cat, radians
    this.pitch = DEFAULT_VIEW.pitch; // camera height angle, radians
    this.spin = 0; // leftover turning speed after a flick
    this.ok = false;
    this._frame = null;
    this._last = 0;

    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) return;
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.loc = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      normal: gl.getAttribLocation(prog, 'aNormal'),
    };
    for (const name of ['uViewProj', 'uModel', 'uNormalMat', 'uColor', 'uAlpha', 'uShade', 'uEye', 'uRim', 'uHolo', 'uTime']) {
      this.loc[name] = gl.getUniformLocation(prog, name);
    }
    const mesh = (data) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { buffer, count: data.length / 6 };
    };
    this.meshes = { sphere: mesh(sphereMesh()), box: mesh(boxMesh()), cone: mesh(coneMesh()) };
    gl.enableVertexAttribArray(this.loc.pos);
    gl.enableVertexAttribArray(this.loc.normal);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    this.ok = true;

    this._resize = () => this._fit();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(this._resize).observe(canvas);
    this._fit();
  }

  setSpeed(kph) {
    this.targetKph = Math.max(0, kph || 0);
  }

  /** Turn the camera: `dYaw` around the cat, `dPitch` up and down (radians). */
  orbit(dYaw, dPitch = 0) {
    this.spin = 0;
    this.setView(this.yaw + dYaw, this.pitch + dPitch);
  }

  setView(yaw, pitch) {
    this.yaw = Number.isFinite(yaw) ? yaw % TAU : DEFAULT_VIEW.yaw;
    this.pitch = Math.min(1.35, Math.max(0.04, Number.isFinite(pitch) ? pitch : DEFAULT_VIEW.pitch));
    if (this.ok && !this.running) this._draw();
  }

  /** Keep turning after a flick; `speed` is in radians per second. */
  fling(speed) {
    this.spin = Math.max(-8, Math.min(8, speed || 0));
  }

  /** Pick one of BREEDS by key; unknown keys fall back to the tabby. */
  setBreed(key) {
    this.breedKey = key in BREEDS ? key : 'tabby';
    this.breed = BREEDS[this.breedKey];
    this.palette = Object.fromEntries(
      Object.entries({ ...DEFAULT_PALETTE, ...this.breed.palette }).map(([k, v]) => [k, hex(v)]),
    );
    if (this.ok && !this.running) this._draw();
  }

  /** 'tabby' (shaded fur) or 'holo' (teal hologram). */
  setStyle(style) {
    this.holo = style === 'holo';
    if (this.ok && !this.running) this._draw();
  }

  setIncline(percent) {
    this.targetIncline = percent || 0;
  }

  start() {
    if (!this.ok || this.running) return;
    this.running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this._update(dt);
      this._draw();
      this._frame = requestAnimationFrame(loop);
    };
    this._frame = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._frame);
  }

  /** Advance and draw one frame without the animation loop (used for tests and reduced motion). */
  renderOnce(dt = 0) {
    if (!this.ok) return;
    this._update(dt);
    this._draw();
  }

  _fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.ok && !this.running) this._draw();
  }

  _update(dt) {
    // Ease towards the treadmill's speed so changes look like acceleration.
    this.kph += (this.targetKph - this.kph) * Math.min(1, dt * 2.5);
    this.incline += (this.targetIncline - this.incline) * Math.min(1, dt * 2);
    if (this.kph < 0.02 && this.targetKph === 0) this.kph = 0;
    const moving = smooth(0, 1, this.kph);
    const cadence = moving * (0.95 + 0.115 * this.kph); // stride cycles per second
    this.phase = (this.phase + dt * cadence * TAU) % (TAU * 64);
    this.belt = (this.belt + dt * (this.kph / 3.6) * 0.75) % 1000;
    this.time += dt;
    if (this.spin) {
      this.yaw += this.spin * dt;
      this.spin *= Math.exp(-dt * 4);
      if (Math.abs(this.spin) < 0.02) this.spin = 0;
    }
  }

  _part(mesh, model, color, { alpha = 1, shade = 1 } = {}) {
    const gl = this.gl;
    const m = this.meshes[mesh];
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buffer);
    gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(this.loc.normal, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(this.loc.uModel, false, model);
    gl.uniformMatrix3fv(this.loc.uNormalMat, false, normalMatrix(model));
    gl.uniform3fv(this.loc.uColor, color);
    gl.uniform1f(this.loc.uAlpha, alpha);
    gl.uniform1f(this.loc.uShade, shade);
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }

  /** Ellipsoid centred at (x,y,z) in the frame `m`, with radii (a,b,c). */
  _ell(m, x, y, z, a, b, c, color, opts) {
    this._part('sphere', sc(tr(m, x, y, z), a, b, c), color, opts);
  }

  _draw() {
    const gl = this.gl;
    const P = this.palette;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Camera: three-quarter view, pulled back on narrow canvases so the cat always fits.
    const aspect = width / height;
    const fov = 0.5;
    const need = 1.5 / Math.tan(fov / 2) / Math.min(aspect, 1.9);
    const dist = Math.max(3.9, need);
    const sway = Math.sin(this.time * 0.25) * 0.08;
    const yaw = this.yaw + sway, cp = Math.cos(this.pitch);
    const dir = [Math.sin(yaw) * cp, Math.sin(this.pitch), Math.cos(yaw) * cp];
    const eye = [0.1 + dir[0] * dist * 1.04, 0.6 + dir[1] * dist * 1.04, dir[2] * dist * 1.04];
    const viewProj = mul(perspective(fov, aspect, 0.1, 50), lookAt(eye, [0.1, 0.6, 0], [0, 1, 0]));
    gl.uniformMatrix4fv(this.loc.uViewProj, false, viewProj);
    gl.uniform3fv(this.loc.uEye, eye);
    gl.uniform3fv(this.loc.uRim, P.rim);
    gl.uniform1f(this.loc.uHolo, this.holo ? 1 : 0);
    gl.uniform1f(this.loc.uTime, this.time % 1000);

    const kph = this.kph;
    const moving = smooth(0, 1, kph);
    const trot = smooth(3.5, 5.5, kph);
    const gallop = smooth(7.5, 10.5, kph);
    const ph = this.phase;
    const t = this.time;

    // The whole deck tilts with the treadmill's incline (exaggerated a little so it reads).
    const root = rz(ident(), Math.atan(this.incline / 100) * 1.6);

    // ----- treadmill deck -----
    this._part('box', sc(tr(root, 0, -0.06, 0), 1.55, 0.05, 0.52), P.belt);
    const spacing = 0.36;
    const offset = this.belt % spacing;
    for (let x = 1.5 - offset; x > -1.5; x -= spacing) {
      this._part('box', sc(tr(root, x, -0.008, 0), 0.03, 0.004, 0.5), P.beltStripe, { shade: 0.6 });
    }
    for (const side of [-1, 1]) {
      this._part('box', sc(tr(root, 0, -0.05, side * 0.58), 1.62, 0.075, 0.06), P.frame);
      this._ell(root, side * 1.55, -0.06, 0, 0.07, 0.07, 0.52, P.frame);
    }

    // ----- gait -----
    const amp = moving * mix(mix(0.3, 0.5, trot), 0.85, gallop);
    const fold = moving * mix(mix(0.5, 0.9, trot), 1.3, gallop);
    // Phase offsets per leg (fractions of a stride): front-left, front-right, hind-left, hind-right.
    const walkO = [0, 0.5, 0.75, 0.25], trotO = [0, 0.5, 0.5, 0], gallopO = [0, 0.12, 0.5, 0.62];
    const legPhase = walkO.map((w, i) => ph + TAU * mix(mix(w, trotO[i], trot), gallopO[i], gallop));
    const bounce =
      moving * mix(mix(0.012, 0.03, trot) * Math.abs(Math.sin(ph)), 0.09 * (0.5 + 0.5 * Math.sin(ph - 0.6)), gallop);
    const flex = gallop * 0.2 * Math.sin(ph + 0.4); // spine bunches and stretches in a gallop
    const breathe = 1 + (1 - moving) * 0.02 * Math.sin(t * 2.2);
    const lean = mix(0, -0.07, gallop) + moving * 0.02 * Math.sin(ph * 2);

    const B = this.breed;
    const G = B.girth, L = B.legs, K = B.limb;
    const catRoot = sc(root, B.scale, B.scale, B.scale);
    gl.uniform3fv(this.loc.uRim, P.rim.map((x) => x * B.rimGain));

    // Soft contact shadow.
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    this._ell(catRoot, 0, 0.005, 0, 0.82 - bounce, 0.001, (0.3 - bounce) * G, [0, 0, 0], { alpha: 0.32, shade: 0 });
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    const body = rz(tr(catRoot, 0, 0.1 + 0.5 * L + bounce, 0), lean);
    this._ell(body, 0, 0, 0, 0.5, 0.25 * breathe * G, 0.23 * G, P.fur);
    this._ell(body, 0.02, -0.12 * G, 0, 0.4, 0.15 * G, 0.15 * G, P.cream);
    if (B.stripes) {
      for (const [x, w] of [[0.16, 0.2], [-0.02, 0.215], [-0.2, 0.205]]) {
        this._ell(body, x, 0.1 * G, 0, 0.028, 0.17 * G, w * 0.93 * G, P.furDark); // tabby stripes
      }
    }

    const chest = rz(tr(body, 0.18, 0, 0), flex);
    this._ell(chest, 0.14, 0.0, 0, 0.3, 0.27 * breathe * G, 0.25 * G, P.fur);
    this._ell(chest, 0.24, -0.1 * G, 0, 0.17 * B.bib, 0.17 * G * B.bib, 0.16 * G * B.bib, P.cream);
    const hips = rz(tr(body, -0.18, 0, 0), -flex);
    this._ell(hips, -0.17, 0.01, 0, 0.3, 0.26 * G, 0.245 * G, P.fur);

    const leg = (parent, hx, hy, hz, phase, hind) => {
      const s = Math.sin(phase), c = Math.cos(phase);
      const upperRest = hind ? 0.38 : 0.05;
      const lowerRest = hind ? -0.76 : -0.1;
      let m = rz(tr(parent, hx, hy, hz * G), upperRest + amp * s);
      this._ell(m, 0, -0.13 * L, 0, (hind ? 0.1 : 0.08) * K, 0.165 * L, (hind ? 0.095 : 0.08) * K, P.fur);
      m = rz(tr(m, 0, -0.26 * L, 0), lowerRest - fold * Math.max(0, c));
      this._ell(m, 0, -0.12 * L, 0, 0.055 * K, 0.15 * L, 0.055 * K, P.fur);
      const paw = rz(tr(m, 0, -0.25 * L, 0), -(upperRest + lowerRest) - amp * s * 0.5);
      this._ell(paw, 0.035, 0, 0, 0.085 * K, 0.05, 0.065 * K, P.cream);
    };
    leg(chest, 0.22, -0.1, 0.13, legPhase[0], false);
    leg(chest, 0.22, -0.1, -0.13, legPhase[1], false);
    leg(hips, -0.22, -0.08, 0.14, legPhase[2], true);
    leg(hips, -0.22, -0.08, -0.14, legPhase[3], true);

    // ----- tail: a chain that waves when idle and streams back at speed -----
    let tail = rz(tr(hips, -0.42, 0.1, 0), mix(1.12, 1.42, moving) + 0.1 * Math.sin(t * 1.3));
    for (let i = 0; i < 6; i++) {
      const wave = mix(0.22, 0.1, moving) * Math.sin(t * 1.6 * (1 - moving) + ph * 0.5 * moving - i * 0.7);
      tail = rx(rz(tail, mix(-0.27, -0.05, moving) + wave * 0.6), wave * mix(1, 0.4, moving));
      const r = (0.062 - i * 0.004) * K;
      this._ell(tail, 0, 0.09, 0, r, 0.11, r, i === 5 ? P.tailTip : i % 2 ? P.furDark : P.fur);
      tail = tr(tail, 0, 0.135, 0);
    }

    // ----- neck and head -----
    const lookAround = (1 - moving) * 0.45 * Math.sin(t * 0.5) * smooth(0.2, 1, Math.sin(t * 0.23));
    const neck = rz(tr(chest, 0.36, 0.1, 0), 0.5 - gallop * 0.25 - flex * 0.6);
    this._ell(neck, 0.08, 0.02, 0, 0.2, 0.17 * Math.sqrt(G), 0.17 * Math.sqrt(G), P.fur);
    const headAt = ry(rz(tr(neck, 0.24, 0.04, 0), -0.5 + gallop * 0.2 + moving * 0.03 * Math.sin(ph * 2 + 1)), lookAround);
    const head = sc(headAt, B.head, B.head, B.head);
    this._ell(head, 0.08, 0.06, 0, 0.23, 0.2, 0.22, P.fur);
    if (B.stripes) this._ell(head, 0.03, 0.12, 0, 0.17, 0.15, 0.1, P.furDark); // forehead marking
    this._ell(head, 0.24, 0.0, 0, 0.11, 0.085, 0.13, P.cream); // muzzle
    this._ell(head, 0.34, 0.03, 0, 0.03, 0.022, 0.035, P.nose, { shade: 0.5 });
    const blink = Math.sin(t * 0.9) > 0.985 || (moving > 0.5 && gallop > 0.9 && Math.sin(t * 0.4) > 0.9) ? 0.12 : 1;
    for (const side of [-1, 1]) {
      // Slanted eyes are almond shaped and tilted so the outer corner sits higher.
      const eye = rx(tr(head, 0.245, 0.1, side * 0.115), -side * B.slant);
      const tall = (B.slant ? 0.03 : 0.042) * blink;
      const wide = B.slant ? 0.042 : B.iris ? 0.037 : 0.034;
      if (B.iris) {
        this._ell(eye, 0, 0, 0, 0.03, tall, wide, P.iris, { shade: 0.35 });
        this._ell(eye, 0.011, 0, side * 0.021, 0.015, tall * 0.84, wide * 0.52, P.eye, { shade: 0.2 }); // pupil
      } else {
        this._ell(eye, 0, 0, 0, 0.03, tall, wide, P.eye, { shade: 0.3 });
      }
      this._ell(eye, 0.018, tall * 0.36, side * (B.iris ? 0.03 : -0.008), 0.009, 0.011 * blink, 0.009, [1, 1, 1], { shade: 0 });
      const ear = rx(rz(tr(head, 0.02, 0.19, side * 0.13), 0.12 - gallop * 0.45), side * 0.28);
      this._part('cone', sc(ear, 0.085, 0.17, 0.06), P.fur);
      this._part('cone', sc(tr(ear, 0.02, 0.012, 0), 0.05, 0.12, 0.035), P.pink, { shade: 0.6 });
      for (const tilt of [-0.18, 0.05, 0.28]) {
        const whisker = rz(ry(tr(head, 0.27, -0.01, side * 0.1), -side * 1.15), tilt);
        this._part('box', sc(tr(whisker, 0.11, 0, 0), 0.11, 0.003, 0.003), [1, 1, 1], { shade: 0.2 });
      }
    }
  }
}
