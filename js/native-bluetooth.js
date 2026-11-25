// A small Web Bluetooth look-alike on top of the Capacitor Bluetooth plugin, used
// inside the native iOS app where the web view has no Bluetooth of its own.
// It offers just the part of the API this app uses, so bluetooth.js and heart.js
// run unchanged. Pure logic: the plugin (`ble`) and the device picker (`choose`)
// are passed in, which lets the Node tests drive it with a fake plugin.

const lower = (uuid) => String(uuid ?? '').toLowerCase();

const notFound = (message) => Object.assign(new Error(message), { name: 'NotFoundError' });

const toView = (data) =>
  data instanceof DataView ? data : ArrayBuffer.isView(data) ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);

/** Does a scan result satisfy Web Bluetooth request options (any one filter is enough)? */
export function matchesRequest(options, result) {
  const name = result.localName ?? result.device?.name ?? '';
  if (options.acceptAllDevices) return !!name;
  const advertised = (result.uuids ?? []).map(lower);
  return (options.filters ?? []).some(
    (f) =>
      (f.services || f.name || f.namePrefix) &&
      (!f.services || f.services.every((s) => advertised.includes(lower(s)))) &&
      (!f.name || name === f.name) &&
      (!f.namePrefix || name.startsWith(f.namePrefix)),
  );
}

function makeCharacteristic(ble, deviceId, service, info) {
  const listeners = new Set();
  const uuid = lower(info.uuid);
  const c = {
    uuid,
    properties: info.properties ?? {},
    value: null,
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
    async startNotifications() {
      await ble.startNotifications(deviceId, service, uuid, (value) => {
        c.value = value;
        for (const fn of [...listeners]) fn({ target: c });
      });
      return c;
    },
    async stopNotifications() {
      await ble.stopNotifications(deviceId, service, uuid);
      return c;
    },
    async readValue() {
      c.value = await ble.read(deviceId, service, uuid);
      return c.value;
    },
    writeValueWithoutResponse: (data) => ble.writeWithoutResponse(deviceId, service, uuid, toView(data)),
    writeValueWithResponse: (data) => ble.write(deviceId, service, uuid, toView(data)),
    writeValue: (data) =>
      c.properties.write || !c.properties.writeWithoutResponse
        ? ble.write(deviceId, service, uuid, toView(data))
        : ble.writeWithoutResponse(deviceId, service, uuid, toView(data)),
  };
  return c;
}

function makeDevice(ble, { deviceId, name }) {
  const listeners = new Set();
  const device = {
    id: deviceId,
    name: name || '',
    addEventListener(type, fn) {
      if (type === 'gattserverdisconnected') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
  };
  const gatt = {
    device,
    connected: false,
    async connect() {
      await ble.connect(
        deviceId,
        () => {
          const was = gatt.connected;
          gatt.connected = false;
          if (was) for (const fn of [...listeners]) fn({ target: device });
        },
        { timeout: 15000 },
      );
      gatt.connected = true;
      const services = await ble.getServices(deviceId);
      return {
        device,
        connected: true,
        async getPrimaryService(wanted) {
          const found = services.find((s) => lower(s.uuid) === lower(wanted));
          if (!found) throw notFound(`Service ${wanted} not found on ${device.name || 'the device'}.`);
          const service = lower(found.uuid);
          const chars = (found.characteristics ?? []).map((info) => makeCharacteristic(ble, deviceId, service, info));
          return {
            uuid: service,
            getCharacteristics: async () => chars,
            async getCharacteristic(uuid) {
              const c = chars.find((x) => x.uuid === lower(uuid));
              if (!c) throw notFound(`Characteristic ${uuid} not found.`);
              return c;
            },
          };
        },
      };
    },
    /** Like the web version this returns at once; the link is dropped in the background. */
    disconnect() {
      gatt.connected = false; // a deliberate disconnect is not reported as a lost link
      Promise.resolve(ble.disconnect(deviceId)).catch(() => {});
    },
  };
  device.gatt = gatt;
  return device;
}

/**
 * @param ble     the plugin's BleClient
 * @param choose  async ({ start(onDevice), options }) => device | null. Shows the
 *                devices as they are found and resolves with the one picked, or null.
 */
export function createBluetooth(ble, { choose }) {
  let ready = null;
  return {
    native: true,
    async requestDevice(options = {}) {
      await (ready ??= ble.initialize().catch((err) => {
        ready = null; // let the next tap try again, e.g. after Bluetooth is switched on
        throw err;
      }));
      const seen = new Set();
      let scanning = false;
      try {
        const chosen = await choose({
          options,
          start: async (onDevice) => {
            scanning = true;
            await ble.requestLEScan({ allowDuplicates: false }, (result) => {
              const id = result.device?.deviceId;
              if (!id || seen.has(id) || !matchesRequest(options, result)) return;
              seen.add(id);
              onDevice({ deviceId: id, name: result.localName ?? result.device.name ?? 'Unnamed device', rssi: result.rssi ?? null });
            });
          },
        });
        if (!chosen) throw notFound('No device was chosen.');
        return makeDevice(ble, chosen);
      } finally {
        if (scanning) await Promise.resolve(ble.stopLEScan()).catch(() => {});
      }
    },
  };
}
