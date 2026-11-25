// High-level iFit client. Talks through a "transport" object:
//   { name, open(onData, onDisconnect), write(Uint8Array), close() }
// so the same code drives a real treadmill (Web Bluetooth) or the built-in simulator.

import {
  CHARS,
  Command,
  Equipment,
  Mode,
  Reassembler,
  buildRequest,
  buildWriteRead,
  frame,
  fromHex,
  parseEquipmentInformation,
  parseFirmware,
  parseIdList,
  parseReadValues,
  parseReference,
  parseResponseHeader,
  parseSerial,
  toHex,
} from './protocol.js';
import { orderedCodes } from './codes.js';

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const LIVE_VALUES = [
  'Kph',
  'Incline',
  'CurrentDistance',
  'Pulse',
  'Mode',
  'CurrentKph',
  'CurrentIncline',
  'CurrentTime',
  'CurrentCalories',
];
const LIMIT_VALUES = ['MaxIncline', 'MinIncline', 'MaxKph', 'MinKph', 'MaxPulse', 'Metric'];

export class IfitClient extends EventTarget {
  constructor(transport, options = {}) {
    super();
    this.transport = transport;
    this.writeDelayMs = options.writeDelayMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.settleMs = options.settleMs ?? 600;
    this.connected = false;
    this.activation = null; // { code, model } once the treadmill accepted a code
    this.info = {
      equipment: Equipment.GENERAL,
      supported: new Set(),
      capabilities: [],
      commands: [],
      firmware: null,
      serial: null,
      reference: null,
      limits: {},
    };
    this.values = {};
    this._queue = Promise.resolve();
    this._pending = null;
    this._reassembler = new Reassembler();
    this._pollTimer = null;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _log(message) {
    this._emit('log', message);
  }

  async connect() {
    await this.transport.open(
      (chunk) => this._onData(chunk),
      () => this._onDisconnect(),
    );
    this.connected = true;
    await sleep(this.settleMs);

    const { header, response } = await this._command(Command.EQUIPMENT_INFORMATION);
    this.info.equipment = header.equipment;
    this.info.supported = new Set(parseEquipmentInformation(response));
    this._log(`equipment type ${header.equipment}, ${this.info.supported.size} characteristics`);

    this.info.capabilities = await this._optional(Command.SUPPORTED_CAPABILITIES, [], parseIdList, []);
    this.info.commands = await this._optional(Command.SUPPORTED_COMMANDS, [], parseIdList, []);
    const supports = (command) => this.info.commands.includes(command);
    if (supports(Command.EQUIPMENT_REFERENCE)) {
      this.info.reference = await this._optional(Command.EQUIPMENT_REFERENCE, [0, 0], parseReference, null);
    }
    if (supports(Command.EQUIPMENT_FIRMWARE)) {
      this.info.firmware = await this._optional(Command.EQUIPMENT_FIRMWARE, [0, 0], parseFirmware, null);
    }
    if (supports(Command.EQUIPMENT_SERIAL)) {
      this.info.serial = await this._optional(Command.EQUIPMENT_SERIAL, [0, 0], parseSerial, null);
    }
    try {
      this.info.limits = await this.read(LIMIT_VALUES);
    } catch (err) {
      this._log(`could not read limits: ${err.message}`);
    }
    return this.info;
  }

  /**
   * Unlock control. Tries `preferred` first, then every known code.
   * Returns { code, model } or null when nothing was accepted (monitoring still works).
   */
  async activate({ preferred, onProgress, only } = {}) {
    const candidates = only ? [{ code: only, model: 'selected code' }] : orderedCodes(preferred);
    for (let i = 0; i < candidates.length; i++) {
      if (!this.connected) throw new Error('disconnected during activation');
      const candidate = candidates[i];
      onProgress?.(i + 1, candidates.length, candidate.model);
      try {
        await this._command(Command.ENABLE, Array.from(fromHex(candidate.code)), 2500);
        await this.read(['MaxIncline', 'MinIncline'], 2500);
        this.activation = candidate;
        this._log(`activated with ${candidate.model}`);
        await this._afterEnable();
        return candidate;
      } catch (err) {
        this._log(`code ${candidate.model} rejected: ${err.message}`);
      }
    }
    this.activation = null;
    return null;
  }

  /** The two writes the iFit app sends straight after ENABLE; harmless if unsupported. */
  async _afterEnable() {
    for (const flags of [{ Flag108: 1 }, { Flag95: 0 }]) {
      const [name] = Object.keys(flags);
      if (!this.info.supported.has(CHARS[name].id)) continue;
      try {
        await this.write(flags);
      } catch (err) {
        this._log(`post-unlock write ${name} failed: ${err.message}`);
      }
    }
  }

  async read(names, timeoutMs) {
    return this.writeAndRead({}, names, timeoutMs);
  }

  async write(values) {
    return this.writeAndRead(values, []);
  }

  async writeAndRead(writes, readNames, timeoutMs) {
    const { payload, reads, written } = buildWriteRead(this.info.supported, writes, readNames);
    const requested = Object.keys(writes);
    if (requested.length && written.length !== requested.length) {
      const missing = requested.filter((name) => !written.includes(name));
      throw new Error(`treadmill does not support ${missing.join(', ')}`);
    }
    const { response } = await this._command(Command.WRITE_AND_READ, payload, timeoutMs);
    return parseReadValues(response, reads);
  }

  setSpeed(kph) {
    return this.write({ Kph: kph });
  }

  setIncline(percent) {
    return this.write({ Incline: percent });
  }

  start() {
    return this.write({ Mode: Mode.ACTIVE });
  }

  pause() {
    return this.write({ Mode: Mode.PAUSE });
  }

  /**
   * Stop the belt, then end the workout.
   * The Carbon TLX refuses a direct Running -> Idle change (status 4), so the belt is
   * halted first with Pause (or speed 0), which it does accept. Ending the paused
   * workout is best effort: the belt is already still if the treadmill refuses.
   * Returns true when the treadmill went back to idle.
   */
  async stop() {
    const mode = this.values.Mode;
    if (mode !== Mode.PAUSE && mode !== Mode.IDLE && mode !== Mode.SUMMARY) {
      try {
        await this.write({ Mode: Mode.PAUSE });
      } catch (err) {
        this._log(`pause refused (${err.message}), setting speed 0`);
        await this.write({ Kph: 0 });
      }
    }
    for (const next of [Mode.IDLE, Mode.SUMMARY, Mode.IDLE]) {
      try {
        await this.write({ Mode: next });
        if (next === Mode.IDLE) return true;
      } catch (err) {
        this._log(`mode ${next} refused while ending workout: ${err.message}`);
        if (next === Mode.SUMMARY) break;
      }
    }
    return false;
  }

  async refresh() {
    const values = await this.read(LIVE_VALUES);
    this.values = { ...this.values, ...values };
    this._emit('values', this.values);
    return this.values;
  }

  startPolling(intervalMs = 1000) {
    this.stopPolling();
    const tick = async () => {
      if (!this.connected) return;
      try {
        await this.refresh();
      } catch (err) {
        this._log(`poll failed: ${err.message}`);
      }
      if (this.connected && this._pollTimer !== null) this._pollTimer = setTimeout(tick, intervalMs);
    };
    this._pollTimer = setTimeout(tick, 0);
  }

  stopPolling() {
    if (this._pollTimer !== null) clearTimeout(this._pollTimer);
    this._pollTimer = null;
  }

  async disconnect() {
    this.stopPolling();
    this.connected = false;
    await this.transport.close();
  }

  async _optional(command, payload, parse, fallback) {
    try {
      const { response } = await this._command(command, payload);
      return parse(response) ?? fallback;
    } catch (err) {
      this._log(`command 0x${command.toString(16)} failed: ${err.message}`);
      return fallback;
    }
  }

  /** Queue one request/response exchange; exchanges never overlap. */
  _command(command, payload = [], timeoutMs = this.timeoutMs) {
    const run = async () => {
      if (!this.connected) throw new Error('not connected');
      const request = buildRequest(this.info.equipment, command, payload);
      const response = await this._exchange(request, timeoutMs);
      return { header: parseResponseHeader(response, command), response };
    };
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  async _exchange(request, timeoutMs) {
    this._reassembler = new Reassembler();
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error('no answer from treadmill'));
      }, timeoutMs);
      this._pending = {
        resolve: (value) => {
          clearTimeout(timer);
          this._pending = null;
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          this._pending = null;
          reject(err);
        },
      };
    });
    answer.catch(() => {}); // a write failure below must not leave this unhandled
    this._emit('traffic', `> ${toHex(request)}`);
    try {
      for (const chunk of frame(request)) {
        await this.transport.write(chunk);
        await sleep(this.writeDelayMs);
      }
    } catch (err) {
      this._pending?.reject(err);
      throw err;
    }
    return answer;
  }

  _onData(chunk) {
    if (!this._pending) return;
    try {
      const message = this._reassembler.push(chunk);
      if (message) {
        this._emit('traffic', `< ${toHex(message)}`);
        this._pending.resolve(message);
      }
    } catch (err) {
      this._pending.reject(err);
    }
  }

  _onDisconnect() {
    const wasConnected = this.connected;
    this.connected = false;
    this.stopPolling();
    this._pending?.reject(new Error('treadmill disconnected'));
    if (wasConnected) this._emit('disconnected');
  }
}

export { CHARS, Mode };
