import test from 'node:test';
import assert from 'node:assert/strict';

import { createBluetooth, matchesRequest } from '../js/native-bluetooth.js';
import { BluetoothTransport } from '../js/bluetooth.js';
import { IfitClient } from '../js/treadmill.js';
import { SimulatorTransport } from '../js/simulator.js';
import { HeartMonitor } from '../js/heart.js';
import { Mode, UUIDS } from '../js/protocol.js';
import { CODES } from '../js/codes.js';

const HEART = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const BATTERY = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';
const TREADMILL_REQUEST = { filters: [{ services: [UUIDS.service] }, { namePrefix: 'I_' }], optionalServices: [UUIDS.service] };

/**
 * A stand-in for the Capacitor plugin's BleClient with the same method
 * signatures, offering a simulated treadmill and a heart-rate strap.
 */
function fakePlugin() {
  const sim = new SimulatorTransport({ latencyMs: 0 });
  const calls = [];
  const onDisconnect = new Map();
  const notify = new Map();
  let scanning = null;
  const view = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
  const ble = {
    sim,
    calls,
    initialize: async () => calls.push('initialize'),
    async requestLEScan(options, callback) {
      calls.push('scan');
      scanning = callback;
      // Advertisements as CoreBluetooth reports them: the treadmill by name only, the strap with its service.
      callback({ device: { deviceId: 'tv' }, localName: 'Living room TV', uuids: [] });
      callback({ device: { deviceId: 'tread-1', name: 'I_TL' }, localName: 'I_TL', rssi: -55, uuids: [] });
      callback({ device: { deviceId: 'tread-1', name: 'I_TL' }, localName: 'I_TL', rssi: -57, uuids: [] }); // repeat
      callback({ device: { deviceId: 'strap-1' }, localName: 'Polar H10 1234', rssi: -70, uuids: [HEART.toUpperCase()] });
      callback({ device: { deviceId: 'anon' }, uuids: [] });
    },
    stopLEScan: async () => {
      calls.push('stopScan');
      scanning = null;
    },
    async connect(deviceId, callback, options) {
      calls.push(`connect ${deviceId} ${options?.timeout}`);
      onDisconnect.set(deviceId, callback);
      if (deviceId === 'tread-1') await sim.open((bytes) => notify.get(`tread-1|${UUIDS.char1535}`)?.(view(bytes)));
    },
    disconnect: async (deviceId) => calls.push(`disconnect ${deviceId}`),
    getServices: async (deviceId) =>
      deviceId === 'tread-1'
        ? [
            {
              uuid: UUIDS.service.toUpperCase(),
              characteristics: [
                { uuid: UUIDS.char1534, properties: { write: true, writeWithoutResponse: true, notify: false, indicate: false } },
                { uuid: UUIDS.char1535, properties: { write: false, writeWithoutResponse: false, notify: true, indicate: false } },
              ],
            },
          ]
        : [
            { uuid: HEART, characteristics: [{ uuid: HEART_MEASUREMENT, properties: { notify: true } }] },
            { uuid: BATTERY, characteristics: [{ uuid: BATTERY_LEVEL, properties: { read: true } }] },
          ],
    async startNotifications(deviceId, service, characteristic, callback) {
      assert.equal(service, service.toLowerCase(), 'the plugin wants lower-case UUIDs');
      notify.set(`${deviceId}|${characteristic}`, callback);
    },
    stopNotifications: async () => {},
    read: async () => view([83]),
    async writeWithoutResponse(deviceId, service, characteristic, value) {
      assert.ok(value instanceof DataView);
      assert.equal(characteristic, UUIDS.char1534);
      calls.push('writeWithoutResponse');
      await sim.write(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
    },
    write: async () => calls.push('write'),
    // test helpers
    drop: (deviceId) => onDisconnect.get(deviceId)?.(deviceId),
    push: (deviceId, characteristic, bytes) => notify.get(`${deviceId}|${characteristic}`)?.(view(bytes)),
    isScanning: () => !!scanning,
  };
  return ble;
}

/** Picks the first device offered, like a user tapping it; records everything that was listed. */
const pickFirst = (listed = []) => async ({ start }) => {
  let first = null;
  await start((device) => {
    listed.push(device);
    first ??= device;
  });
  return first;
};

test('scan results are matched like Web Bluetooth filters: any one filter is enough', () => {
  const byName = { device: { deviceId: 'a' }, localName: 'I_TL', uuids: [] };
  const byService = { device: { deviceId: 'b', name: 'Treadmill' }, uuids: [UUIDS.service.toUpperCase()] };
  const other = { device: { deviceId: 'c' }, localName: 'Polar H10', uuids: [HEART] };
  assert.ok(matchesRequest(TREADMILL_REQUEST, byName));
  assert.ok(matchesRequest(TREADMILL_REQUEST, byService));
  assert.ok(!matchesRequest(TREADMILL_REQUEST, other));
  assert.ok(matchesRequest({ filters: [{ services: [HEART] }] }, other));
  assert.ok(matchesRequest({ acceptAllDevices: true }, other));
  assert.ok(!matchesRequest({ acceptAllDevices: true }, { device: { deviceId: 'd' } }), 'nameless devices are left out');
  assert.ok(!matchesRequest({ filters: [{}] }, other), 'an empty filter matches nothing');
});

test('the treadmill is found, unlocked and driven through the native plugin', async () => {
  const ble = fakePlugin();
  const listed = [];
  const bluetooth = createBluetooth(ble, { choose: pickFirst(listed) });
  const device = await bluetooth.requestDevice(TREADMILL_REQUEST);
  assert.deepEqual(listed.map((d) => d.name), ['I_TL'], 'only the treadmill is offered, once');
  assert.equal(device.name, 'I_TL');
  assert.ok(!ble.isScanning(), 'the scan is stopped after the choice');

  const client = new IfitClient(new BluetoothTransport(device), { writeDelayMs: 0, settleMs: 0, timeoutMs: 500 });
  let lost = 0;
  client.addEventListener('disconnected', () => lost++);
  await client.connect();
  assert.equal((await client.activate()).code, CODES[0].code);
  await client.start();
  await client.setSpeed(7.2);
  const v = await client.refresh();
  assert.equal(v.Mode, Mode.ACTIVE);
  assert.equal(v.Kph, 7.2);
  assert.ok(ble.calls.includes('writeWithoutResponse') && !ble.calls.includes('write'));
  assert.ok(ble.calls.includes('connect tread-1 15000'));

  // The treadmill going out of range is reported to the app as a lost link.
  ble.drop('tread-1');
  assert.equal(lost, 1);
  assert.equal(device.gatt.connected, false);
});

test('cancelling the device list looks like a cancelled browser chooser', async () => {
  const ble = fakePlugin();
  const bluetooth = createBluetooth(ble, {
    choose: async ({ start }) => {
      await start(() => {});
      return null;
    },
  });
  await assert.rejects(bluetooth.requestDevice(TREADMILL_REQUEST), { name: 'NotFoundError' });
  assert.ok(!ble.isScanning());
});

test('Bluetooth being off is reported, and the next attempt tries again', async () => {
  const ble = fakePlugin();
  let off = true;
  ble.initialize = async () => {
    if (off) throw new Error('Bluetooth is turned off');
  };
  const bluetooth = createBluetooth(ble, { choose: pickFirst() });
  await assert.rejects(bluetooth.requestDevice(TREADMILL_REQUEST), /turned off/);
  off = false;
  assert.equal((await bluetooth.requestDevice(TREADMILL_REQUEST)).name, 'I_TL');
});

test('the heart rate strap works through the native plugin', async () => {
  const ble = fakePlugin();
  const listed = [];
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'bluetooth');
  Object.defineProperty(globalThis.navigator, 'bluetooth', { value: createBluetooth(ble, { choose: pickFirst(listed) }), configurable: true });
  try {
    const heart = new HeartMonitor();
    await heart.link();
    assert.deepEqual(listed.map((d) => d.name), ['Polar H10 1234']);
    assert.equal(heart.state, 'on');
    assert.equal(heart.name, 'Polar H10 1234');
    assert.equal(heart.battery, 83);
    ble.push('strap-1', HEART_MEASUREMENT, [0x00, 142]);
    assert.equal(heart.bpm, 142);
    heart.unlink();
    assert.equal(heart.state, 'off');
    assert.ok(ble.calls.includes('disconnect strap-1'));
  } finally {
    if (original) Object.defineProperty(globalThis.navigator, 'bluetooth', original);
    else delete globalThis.navigator.bluetooth;
  }
});
