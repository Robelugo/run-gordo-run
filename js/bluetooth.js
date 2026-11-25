// Web Bluetooth transport for iFit equipment.
//
// Written to also run on the Web Bluetooth stand-ins used on iPhone and iPad
// (the Bluefy and WebBLE browsers), which implement an older or smaller part of
// the API than Chrome: no getCharacteristics(), no writeValueWithoutResponse().

import { UUIDS } from './protocol.js';

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/** iPhone, iPod or iPad (an iPad reports itself as a Mac with a touch screen). */
export const isAppleMobile = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent ?? '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const sameUuid = (a, b) => String(a ?? '').toLowerCase() === b;

export class BluetoothTransport {
  constructor(device) {
    this.device = device;
    this.name = device.name || 'iFit treadmill';
    this._writeChar = null;
    this._notifyChar = null;
    this._onNotify = null;
    this._onGone = null;
  }

  /** Shows the browser's device chooser. Must be called from a tap/click. */
  static async request({ showAll = false } = {}) {
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: [UUIDS.service] }
      : { filters: [{ services: [UUIDS.service] }, { namePrefix: 'I_' }], optionalServices: [UUIDS.service] };
    return new BluetoothTransport(await navigator.bluetooth.requestDevice(options));
  }

  /** The service's two characteristics, listed if the browser can, else fetched one by one. */
  async _characteristics(service) {
    try {
      const all = await service.getCharacteristics?.();
      if (all?.length) return all;
    } catch {
      /* fall through to asking for each by UUID */
    }
    const found = [];
    for (const uuid of [UUIDS.char1534, UUIDS.char1535]) {
      try {
        found.push(await service.getCharacteristic(uuid));
      } catch {
        /* not offered */
      }
    }
    return found;
  }

  async open(onData, onDisconnect) {
    const server = await this.device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(UUIDS.service);
    } catch {
      this.device.gatt.disconnect();
      throw new Error('This device does not offer the iFit service. Pick the treadmill (its name usually starts with "I_TL").');
    }
    const chars = await this._characteristics(service);
    // One characteristic notifies, the other accepts writes; choose by what they
    // declare, and by their well-known UUIDs where the browser does not say.
    this._notifyChar =
      chars.find((c) => c.properties?.notify || c.properties?.indicate) ?? chars.find((c) => sameUuid(c.uuid, UUIDS.char1535));
    this._writeChar =
      chars.find((c) => c !== this._notifyChar && (c.properties?.writeWithoutResponse || c.properties?.write)) ??
      chars.find((c) => c !== this._notifyChar && sameUuid(c.uuid, UUIDS.char1534));
    if (!this._notifyChar || !this._writeChar) {
      this.device.gatt.disconnect();
      throw new Error('iFit characteristics not found on this device.');
    }

    this._onNotify = (event) => {
      const view = event.target.value;
      onData(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice());
    };
    this._onGone = () => onDisconnect();
    this._notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
    this.device.addEventListener('gattserverdisconnected', this._onGone);
    await this._notifyChar.startNotifications();
  }

  async write(chunk) {
    const c = this._writeChar;
    const noResponse = c.properties?.writeWithoutResponse && typeof c.writeValueWithoutResponse === 'function';
    if (noResponse) await c.writeValueWithoutResponse(chunk);
    else if (typeof c.writeValueWithResponse === 'function' && c.properties?.write !== false) await c.writeValueWithResponse(chunk);
    else await c.writeValue(chunk); // the original method, the only one older implementations have
  }

  async close() {
    this._notifyChar?.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.device.removeEventListener('gattserverdisconnected', this._onGone);
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
