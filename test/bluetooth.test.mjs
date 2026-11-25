import test from 'node:test';
import assert from 'node:assert/strict';

import { BluetoothTransport } from '../js/bluetooth.js';
import { IfitClient } from '../js/treadmill.js';
import { SimulatorTransport } from '../js/simulator.js';
import { Mode, UUIDS } from '../js/protocol.js';
import { CODES } from '../js/codes.js';

/**
 * A fake Web Bluetooth device wired to the simulated treadmill.
 * `flavour` picks which part of the API it offers:
 *   'chrome'  - the full API, as on Android
 *   'legacy'  - what the iPhone/iPad stand-in browsers offer: characteristics
 *               only by UUID, no `properties`, and only the old writeValue()
 */
function fakeDevice(flavour) {
  const sim = new SimulatorTransport({ latencyMs: 0 });
  const calls = { writeValue: 0, writeValueWithoutResponse: 0, writeValueWithResponse: 0, disconnect: 0 };
  const listeners = new Set();
  const notify = {
    uuid: UUIDS.char1535.toUpperCase(), // some implementations report upper case
    addEventListener: (type, fn) => type === 'characteristicvaluechanged' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    startNotifications: async () =>
      sim.open((bytes) => {
        const copy = Uint8Array.from(bytes);
        const event = { target: { value: new DataView(copy.buffer) } };
        for (const fn of listeners) fn(event);
      }),
  };
  const send = (name) => async (chunk) => {
    calls[name]++;
    await sim.write(Uint8Array.from(chunk));
  };
  const write = { uuid: UUIDS.char1534 };
  if (flavour === 'legacy') write.writeValue = send('writeValue');
  else {
    notify.properties = { notify: true };
    write.properties = { writeWithoutResponse: true, write: true };
    write.writeValue = send('writeValue');
    write.writeValueWithoutResponse = send('writeValueWithoutResponse');
    write.writeValueWithResponse = send('writeValueWithResponse');
  }
  const service = {
    getCharacteristic: async (uuid) => {
      const found = [write, notify].find((c) => c.uuid.toLowerCase() === uuid);
      if (!found) throw new Error('not found');
      return found;
    },
  };
  if (flavour !== 'legacy') service.getCharacteristics = async () => [write, notify];
  const gatt = {
    connected: false,
    connect: async () => {
      gatt.connected = true;
      return { getPrimaryService: async (uuid) => (uuid === UUIDS.service ? service : Promise.reject(new Error('no service'))) };
    },
    disconnect: () => {
      gatt.connected = false;
      calls.disconnect++;
    },
  };
  return { device: { name: 'I_TL', gatt, addEventListener() {}, removeEventListener() {} }, calls, sim };
}

for (const flavour of ['chrome', 'legacy']) {
  test(`the treadmill can be unlocked and driven through the ${flavour} Bluetooth API`, async () => {
    const { device, calls, sim } = fakeDevice(flavour);
    const client = new IfitClient(new BluetoothTransport(device), { writeDelayMs: 0, settleMs: 0, timeoutMs: 500 });
    await client.connect();
    const activation = await client.activate();
    assert.equal(activation.code, CODES[0].code, 'the Carbon TLX code is tried first and accepted');
    await client.start();
    await client.setSpeed(6.5);
    await client.setIncline(2);
    const v = await client.refresh();
    assert.equal(v.Mode, Mode.ACTIVE);
    assert.equal(v.Kph, 6.5);
    assert.equal(v.Incline, 2);
    assert.equal(sim.state.targetKph, 6.5);
    if (flavour === 'legacy') {
      assert.ok(calls.writeValue > 0);
      assert.equal(calls.writeValueWithoutResponse + calls.writeValueWithResponse, 0);
    } else {
      assert.ok(calls.writeValueWithoutResponse > 0);
      assert.equal(calls.writeValue, 0);
    }
    await client.disconnect();
    assert.equal(calls.disconnect, 1);
  });
}

test('a device without the iFit service is refused with a clear message', async () => {
  const { device } = fakeDevice('legacy');
  const connect = device.gatt.connect;
  device.gatt.connect = async () => {
    await connect();
    return { getPrimaryService: async () => Promise.reject(new Error('no service')) };
  };
  await assert.rejects(new BluetoothTransport(device).open(() => {}, () => {}), /does not offer the iFit service/);
});
