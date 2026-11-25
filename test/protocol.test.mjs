import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Command,
  Equipment,
  Mode,
  Reassembler,
  bitmap,
  buildRequest,
  buildWriteRead,
  checksumOk,
  frame,
  parseFirmware,
  parseReference,
  toHex,
  fromHex,
} from '../js/protocol.js';
import { CODES, isValidCode, orderedCodes } from '../js/codes.js';
import { IfitClient } from '../js/treadmill.js';
import { SimulatorTransport } from '../js/simulator.js';

const ALL = new Set([0, 1, 4, 10, 12, 16, 17, 20, 21]);

test('bitmap matches the documented example', () => {
  assert.deepEqual(bitmap([0, 1, 4, 10]), [2, 0x13, 0x04]);
  assert.deepEqual(bitmap([4, 10, 16, 17, 20]), [3, 0x10, 0x04, 0x13]);
  assert.deepEqual(bitmap([]), [0]);
});

test('set speed 10 km/h encodes to the known frame', () => {
  const { payload } = buildWriteRead(ALL, { Kph: 10 }, []);
  assert.deepEqual(payload, [1, 1, 0xe8, 0x03, 0]);
  const request = buildRequest(Equipment.TREADMILL, Command.WRITE_AND_READ, payload);
  // checksum = low byte of 04+09+02+01+01+e8+03+00
  assert.equal(toHex(request), '0204020904090201' + '01e80300' + 'fc');
  assert.ok(checksumOk(request));
  const chunks = frame(request);
  assert.equal(toHex(chunks[0]), 'fe020d02');
  assert.equal(chunks[1].length, 20);
  assert.equal(toHex(chunks[1].subarray(0, 15)), 'ff0d' + toHex(request));
});

test('long messages survive framing and reassembly', () => {
  const message = Uint8Array.from({ length: 44 }, (_, i) => i + 1);
  const chunks = frame(message);
  assert.equal(chunks.length, 4);
  assert.deepEqual([chunks[1][0], chunks[2][0], chunks[3][0]], [0, 1, 0xff]);
  const reassembler = new Reassembler();
  let out = null;
  for (const chunk of chunks) out = reassembler.push(chunk);
  assert.deepEqual(out, message);
});

test('metadata parsers read the documented captures', () => {
  const firmware = fromHex('0104021c041c840250a300302e312e30363132323031372e30393038012a0316');
  assert.equal(parseFirmware(firmware), '0.1.06122017.0908');
  const reference = fromHex('01040221042182026400014d2409002cfe0500780036e8030024f400f40101000102000061');
  assert.equal(parseReference(reference), 392748);
});

test('activation codes are well formed and ordered', () => {
  assert.ok(CODES.every((c) => isValidCode(c.code)));
  assert.equal(new Set(CODES.map((c) => c.code)).size, CODES.length);
  assert.equal(orderedCodes(CODES[7].code)[0].code, CODES[7].code);
  assert.equal(orderedCodes(CODES[7].code).length, CODES.length);
});

function makeClient(simOptions) {
  let clock = 0;
  const sim = new SimulatorTransport({ latencyMs: 0, now: () => clock, ...simOptions });
  const client = new IfitClient(sim, { writeDelayMs: 0, settleMs: 0, timeoutMs: 500 });
  return { sim, client, advance: (ms) => (clock += ms) };
}

test('client connects, discovers and reads limits from the simulator', async () => {
  const { client } = makeClient();
  const info = await client.connect();
  assert.equal(info.equipment, Equipment.TREADMILL);
  assert.ok(info.supported.has(0) && info.supported.has(103));
  assert.equal(info.firmware, '0.1.demo');
  assert.equal(info.serial, '000000-DEMO0001');
  assert.equal(info.reference, 392748);
  assert.equal(info.limits.MaxKph, 16);
  assert.equal(info.limits.MaxIncline, 12);
  assert.equal(info.limits.Metric, true);
});

test('activation walks the code list until one is accepted', async () => {
  const { client, sim } = makeClient({ acceptedCode: CODES[3].code });
  await client.connect();
  const seen = [];
  const result = await client.activate({ onProgress: (i) => seen.push(i) });
  assert.equal(result.code, CODES[3].code);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.ok(sim.enabled);
});

test('activation reports failure when no code fits', async () => {
  const { client } = makeClient({ acceptedCode: 'ff'.repeat(36) });
  await client.connect();
  assert.equal(await client.activate(), null);
});

test('control round trip: start, speed, incline, pause, stop', async () => {
  const { client, advance } = makeClient();
  await client.connect();

  // Locked until activated.
  await client.start();
  assert.equal((await client.refresh()).Mode, Mode.IDLE);

  await client.activate();
  await client.start();
  await client.setSpeed(8.5);
  await client.setIncline(3);
  advance(20000);
  let v = await client.refresh();
  assert.equal(v.Mode, Mode.ACTIVE);
  assert.equal(v.Kph, 8.5);
  assert.equal(v.CurrentKph, 8.5);
  assert.equal(v.CurrentIncline, 3);
  assert.ok(v.CurrentTime >= 19 && v.CurrentTime <= 20);
  assert.ok(v.CurrentDistance > 30);
  assert.ok(v.CurrentCalories > 0);
  assert.ok(v.Pulse.pulse > 100);

  await client.setSpeed(99); // clamped by the treadmill
  assert.equal((await client.refresh()).Kph, 16);

  await client.pause();
  advance(20000);
  v = await client.refresh();
  assert.equal(v.Mode, Mode.PAUSE);
  assert.equal(v.CurrentKph, 0);

  await client.stop();
  assert.equal((await client.refresh()).Mode, Mode.IDLE);
});

test('stop from running pauses first, because the treadmill refuses running -> idle', async () => {
  const { client, advance } = makeClient();
  await client.connect();
  await client.activate();
  await client.start();
  await client.setSpeed(6);
  advance(10000);
  assert.equal((await client.refresh()).Mode, Mode.ACTIVE);
  await assert.rejects(client.write({ Mode: Mode.IDLE }), /status 4/);
  assert.equal(await client.stop(), true);
  advance(10000);
  const v = await client.refresh();
  assert.equal(v.Mode, Mode.IDLE);
  assert.equal(v.CurrentKph, 0);
});

test('a silent treadmill produces a timeout, and the queue recovers', async () => {
  const { client, sim } = makeClient();
  await client.connect();
  const realWrite = sim.write.bind(sim);
  sim.write = async () => {};
  await assert.rejects(client.read(['Mode'], 50), /no answer/);
  sim.write = realWrite;
  assert.equal((await client.read(['Mode'])).Mode, Mode.IDLE);
});
