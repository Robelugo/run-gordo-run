// A pretend treadmill that speaks the iFit protocol at the byte level.
// Used for demo mode and for the automated tests, so the whole client stack is exercised.

import {
  CHARS,
  Command,
  Equipment,
  Mode,
  Reassembler,
  bitmap,
  decodeValue,
  encodeValue,
  frame,
  readBitmap,
  sizeOf,
  toHex,
} from './protocol.js';
import { CODES } from './codes.js';
import { oxygenCost } from './fitness.js';

// The pretend runner's heart: resting pulse, beats per ml/kg/min of effort, and response time.
const REST_BPM = 62;
const BPM_PER_ML = 3.4;
const PULSE_LAG_S = 35;

const BY_ID = new Map(Object.values(CHARS).map((def) => [def.id, def]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const approach = (current, target, maxStep) =>
  Math.abs(target - current) <= maxStep ? target : current + Math.sign(target - current) * maxStep;

export class SimulatorTransport {
  constructor({ acceptedCode = CODES[0].code, latencyMs = 15, now = () => Date.now() } = {}) {
    this.name = 'Demo treadmill';
    this.acceptedCode = acceptedCode;
    this.latencyMs = latencyMs;
    this.now = now;
    this.enabled = false;
    this.state = {
      mode: Mode.IDLE,
      targetKph: 0,
      resumeKph: 0,
      targetIncline: 0,
      kph: 0,
      incline: 0,
      seconds: 0,
      metres: 0,
      kcal: 0,
      hr: REST_BPM,
    };
    this.limits = { MaxKph: 16, MinKph: 1, MaxIncline: 12, MinIncline: 0, MaxPulse: 190, Metric: true };
    this._last = this.now();
    this._reassembler = new Reassembler();
    this._onData = null;
    this._open = false;
  }

  async open(onData) {
    this._onData = onData;
    this._open = true;
    this._last = this.now();
  }

  async write(chunk) {
    if (!this._open) throw new Error('simulator is closed');
    const request = this._reassembler.push(chunk);
    if (!request) return;
    const response = this._respond(request);
    setTimeout(() => {
      if (!this._open) return;
      for (const part of frame(response)) this._onData(part);
    }, this.latencyMs);
  }

  async close() {
    this._open = false;
  }

  _tick() {
    const now = this.now();
    const dt = Math.max(0, (now - this._last) / 1000);
    this._last = now;
    const s = this.state;
    const running = s.mode === Mode.ACTIVE;
    s.kph = approach(s.kph, running ? s.targetKph : 0, (running ? 1 : 2) * dt);
    s.incline = approach(s.incline, s.targetIncline, dt);
    // Pretend runner: pulse follows the effort (speed and incline) with a lag, as a real one does.
    const effort = s.kph > 0.1 ? oxygenCost(s.kph, s.incline) : 3.5;
    s.hr += (REST_BPM + BPM_PER_ML * (effort - 3.5) - s.hr) * (1 - Math.exp(-dt / PULSE_LAG_S));
    if (running) {
      s.seconds += dt;
      s.metres += (s.kph / 3.6) * dt;
      s.kcal += (dt / 60) * 0.0175 * 75 * Math.max(1, s.kph);
    }
  }

  _value(name) {
    const s = this.state;
    switch (name) {
      case 'Kph':
        return s.targetKph;
      case 'Incline':
        return s.targetIncline;
      case 'CurrentKph':
        return s.kph;
      case 'CurrentIncline':
        return s.incline;
      case 'CurrentDistance':
      case 'Distance':
        return s.metres;
      case 'CurrentTime':
      case 'TotalTime':
      case 'UpTime':
        return s.seconds;
      case 'CurrentCalories':
      case 'Calories':
        return s.kcal;
      case 'Mode':
        return s.mode;
      case 'Pulse':
        return s.mode === Mode.IDLE && s.kph <= 0.1 ? { pulse: 0, source: 0 } : { pulse: Math.round(s.hr), source: 1 };
      case 'PausedTime':
        return 0;
      default:
        return this.limits[name] ?? 0;
    }
  }

  _apply(name, value) {
    if (!this.enabled) return true; // control is locked until a valid ENABLE
    const s = this.state;
    if (name === 'Kph') {
      if (s.mode === Mode.ACTIVE) s.targetKph = clamp(value, this.limits.MinKph, this.limits.MaxKph);
    } else if (name === 'Incline') {
      s.targetIncline = clamp(value, this.limits.MinIncline, this.limits.MaxIncline);
    } else if (name === 'Mode') {
      if (value === Mode.ACTIVE) {
        s.targetKph = s.mode === Mode.PAUSE && s.resumeKph ? s.resumeKph : this.limits.MinKph;
        s.mode = Mode.ACTIVE;
      } else if (value === Mode.PAUSE && s.mode === Mode.ACTIVE) {
        s.resumeKph = s.targetKph;
        s.targetKph = 0;
        s.mode = Mode.PAUSE;
      } else if (value === Mode.IDLE) {
        if (s.mode === Mode.ACTIVE) return false; // like the real Carbon TLX: pause first
        Object.assign(s, { mode: Mode.IDLE, targetKph: 0, resumeKph: 0, seconds: 0, metres: 0, kcal: 0 });
      }
    }
    return true;
  }

  _respond(request) {
    this._tick();
    const command = request[6];
    const payload = request.subarray(7, request.length - 1);
    let status = 2;
    let data = [];

    switch (command) {
      case Command.EQUIPMENT_INFORMATION:
        data = [0, 0, 0, 0, 0, 0, 0, 0, ...bitmap([...BY_ID.keys()])];
        break;
      case Command.SUPPORTED_CAPABILITIES:
        data = [6, 65, 66, 70, 71, 77, 78];
        break;
      case Command.SUPPORTED_COMMANDS: {
        const commands = Object.values(Command);
        data = [commands.length, ...commands];
        break;
      }
      case Command.EQUIPMENT_REFERENCE:
        data = [0, 0, 0, 0, 0, 0, 0, ...encodeValue('u32', 392748), 0];
        break;
      case Command.EQUIPMENT_FIRMWARE:
        data = [0, 0, 0, ...Array.from('0.1.demo', (c) => c.charCodeAt(0)), 0];
        break;
      case Command.EQUIPMENT_SERIAL: {
        const serial = Array.from('000000-DEMO0001', (c) => c.charCodeAt(0));
        data = [serial.length, ...serial];
        break;
      }
      case Command.ENABLE:
        if (toHex(payload) === this.acceptedCode) this.enabled = true;
        else status = 3;
        break;
      case Command.WRITE_AND_READ: {
        const writes = readBitmap(payload, 0);
        let pos = writes.next;
        for (const id of writes.ids) {
          const def = BY_ID.get(id);
          if (!def) continue;
          if (!this._apply(def.name, decodeValue(def.type, payload, pos))) status = 4;
          pos += sizeOf(def);
        }
        for (const id of readBitmap(payload, pos).ids) {
          const def = BY_ID.get(id);
          if (def) data.push(...encodeValue(def.type, this._value(def.name)));
        }
        break;
      }
      default:
        status = 3;
    }

    const body = [status, ...data];
    const length = body.length + 4;
    const message = [1, 4, 2, length, Equipment.TREADMILL, length, command, ...body];
    let checksum = 0;
    for (let i = 4; i < message.length; i++) checksum += message[i];
    return Uint8Array.from([...message, checksum & 0xff]);
  }
}
