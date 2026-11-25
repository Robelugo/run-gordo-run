// Direct connection to a Bluetooth heart-rate strap (Polar H10 and any other
// sensor using the standard Heart Rate service), independent of the treadmill.

/** Decode a Heart Rate Measurement (0x2A37) value. */
export function parseHeartRate(bytes) {
  const flags = bytes[0] ?? 0;
  const wide = (flags & 0x01) !== 0;
  const bpm = wide ? (bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8) : (bytes[1] ?? 0);
  let i = wide ? 3 : 2;
  const contactSupported = (flags & 0x04) !== 0;
  const contact = !contactSupported || (flags & 0x02) !== 0;
  if (flags & 0x08) i += 2; // energy expended, not used
  const rr = [];
  if (flags & 0x10) {
    for (; i + 1 < bytes.length; i += 2) rr.push(Math.round(((bytes[i] | (bytes[i + 1] << 8)) / 1024) * 1000));
  }
  return { bpm, contact, rr };
}

// Full UUIDs rather than names ('heart_rate'): every Web Bluetooth implementation,
// including the stand-ins on iPhone and iPad, understands these.
const std = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;
const HEART_SERVICE = std('180d');
const HEART_MEASUREMENT = std('2a37');
const BATTERY_SERVICE = std('180f');
const BATTERY_LEVEL = std('2a19');

const STALE_MS = 6000;
const RETRY_MS = 3000;

export class HeartMonitor extends EventTarget {
  constructor() {
    super();
    this.state = 'off'; // off | connecting | on | reconnecting
    this.name = null;
    this.battery = null;
    this._bpm = 0;
    this._at = 0;
    this._device = null;
    this._wanted = false;
    this._retry = null;
    this._onValue = (event) => {
      const view = event.target.value;
      const reading = parseHeartRate(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      this._bpm = reading.contact ? reading.bpm : 0;
      this._at = Date.now();
      this._emit();
    };
    this._onGone = () => {
      if (!this._wanted) return;
      this._set('reconnecting');
      this._schedule();
    };
  }

  static get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /** Latest heart rate, or 0 when there is no fresh reading. */
  get bpm() {
    return this.state === 'on' && Date.now() - this._at < STALE_MS ? this._bpm : 0;
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }

  _set(state) {
    this.state = state;
    this._emit();
  }

  /** Shows the browser's device chooser; must be called from a tap. */
  async link() {
    if (this.state !== 'off') return;
    this._set('connecting');
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HEART_SERVICE] }],
        optionalServices: [BATTERY_SERVICE],
      });
      this.name = this._device.name || 'Heart rate strap';
      this._wanted = true;
      this._device.addEventListener('gattserverdisconnected', this._onGone);
      await this._open();
    } catch (err) {
      this._teardown();
      this._set('off');
      if (err.name !== 'NotFoundError') throw err; // NotFoundError = chooser cancelled
    }
  }

  async _open() {
    const server = await this._device.gatt.connect();
    const service = await server.getPrimaryService(HEART_SERVICE);
    const measurement = await service.getCharacteristic(HEART_MEASUREMENT);
    measurement.addEventListener('characteristicvaluechanged', this._onValue);
    await measurement.startNotifications();
    this._set('on');
    try {
      const battery = await (await server.getPrimaryService(BATTERY_SERVICE)).getCharacteristic(BATTERY_LEVEL);
      this.battery = (await battery.readValue()).getUint8(0);
      this._emit();
    } catch {
      this.battery = null; // optional
    }
  }

  _schedule() {
    clearTimeout(this._retry);
    this._retry = setTimeout(async () => {
      if (!this._wanted) return;
      try {
        await this._open();
      } catch {
        this._schedule();
      }
    }, RETRY_MS);
  }

  _teardown() {
    this._wanted = false;
    clearTimeout(this._retry);
    this._device?.removeEventListener('gattserverdisconnected', this._onGone);
    try {
      if (this._device?.gatt.connected) this._device.gatt.disconnect();
    } catch {
      /* already gone */
    }
    this._device = null;
    this._bpm = 0;
    this.battery = null;
  }

  unlink() {
    this._teardown();
    this.name = null;
    this._set('off');
  }
}
