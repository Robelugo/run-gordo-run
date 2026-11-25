// iFit BLE protocol: framing, command encoding and value decoding.
// Pure functions, no Bluetooth here, so this runs in the browser and in Node tests.
// Based on the reverse-engineered protocol documented by the zwifit and ianchi/ifit projects.

export const UUIDS = {
  service: '00001533-1412-efde-1523-785feabcd123',
  char1534: '00001534-1412-efde-1523-785feabcd123',
  char1535: '00001535-1412-efde-1523-785feabcd123',
};

export const Equipment = { GENERAL: 2, TREADMILL: 4 };

export const Command = {
  WRITE_AND_READ: 0x02,
  CALIBRATE: 0x06,
  SUPPORTED_CAPABILITIES: 0x80,
  EQUIPMENT_INFORMATION: 0x81,
  EQUIPMENT_REFERENCE: 0x82,
  EQUIPMENT_FIRMWARE: 0x84,
  SUPPORTED_COMMANDS: 0x88,
  ENABLE: 0x90,
  EQUIPMENT_SERIAL: 0x95,
};

export const Mode = {
  UNKNOWN: 0,
  IDLE: 1,
  ACTIVE: 2,
  PAUSE: 3,
  SUMMARY: 4,
  SETTINGS: 7,
  MISSING_SAFETY_KEY: 8,
  WARMUP: 10,
};

export const MODE_LABELS = {
  0: 'Unknown',
  1: 'Idle',
  2: 'Running',
  3: 'Paused',
  4: 'Summary',
  7: 'Settings',
  8: 'Safety key missing',
  10: 'Warm-up',
};

const RESPONSE_OK = 2;
const CHUNK_PAYLOAD = 18;
const HEADER = 0xfe;
const EOF = 0xff;
const CALORIE_SCALE = 100000000 / 1024;

// Characteristics we know the size and encoding of.
export const CHARS = {
  Kph: { id: 0, type: 'double', writable: true },
  Incline: { id: 1, type: 'double', writable: true },
  CurrentDistance: { id: 4, type: 'u32' },
  Distance: { id: 6, type: 'u32' },
  Pulse: { id: 10, type: 'pulse' },
  UpTime: { id: 11, type: 'u32' },
  // 95 and 108 are unnamed flags the iFit app sets right after unlocking a Carbon TLX.
  Flag95: { id: 95, type: 'u8', writable: true },
  Flag108: { id: 108, type: 'u8', writable: true },
  Mode: { id: 12, type: 'u8', writable: true },
  Calories: { id: 13, type: 'calories' },
  CurrentKph: { id: 16, type: 'double' },
  CurrentIncline: { id: 17, type: 'double' },
  CurrentTime: { id: 20, type: 'u32' },
  CurrentCalories: { id: 21, type: 'calories' },
  MaxIncline: { id: 27, type: 'double' },
  MinIncline: { id: 28, type: 'double' },
  MaxKph: { id: 30, type: 'double' },
  MinKph: { id: 31, type: 'double' },
  Metric: { id: 36, type: 'bool', writable: true },
  MaxPulse: { id: 49, type: 'u8' },
  TotalTime: { id: 70, type: 'u32' },
  PausedTime: { id: 103, type: 'u32' },
};
for (const [name, def] of Object.entries(CHARS)) def.name = name;

const SIZES = { double: 2, u8: 1, bool: 1, u32: 4, calories: 4, pulse: 4 };

const readUint = (buf, pos, size) => {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + (buf[pos + i] ?? 0);
  return v;
};

const writeUint = (value, size) => {
  const out = [];
  let v = Math.max(0, Math.round(value));
  for (let i = 0; i < size; i++) {
    out.push(v % 256);
    v = Math.floor(v / 256);
  }
  return out;
};

export function decodeValue(type, buf, pos) {
  switch (type) {
    case 'double':
      return readUint(buf, pos, 2) / 100;
    case 'u8':
      return buf[pos];
    case 'bool':
      return buf[pos] === 1;
    case 'u32':
      return readUint(buf, pos, 4);
    case 'calories':
      return readUint(buf, pos, 4) / CALORIE_SCALE;
    case 'pulse':
      return { pulse: buf[pos], average: buf[pos + 1], count: buf[pos + 2], source: buf[pos + 3] };
    default:
      throw new Error(`unknown value type ${type}`);
  }
}

export function encodeValue(type, value) {
  switch (type) {
    case 'double':
      return writeUint(value * 100, 2);
    case 'u8':
      return writeUint(value, 1);
    case 'bool':
      return [value ? 1 : 0];
    case 'u32':
      return writeUint(value, 4);
    case 'calories':
      return writeUint(value * CALORIE_SCALE, 4);
    case 'pulse':
      return [value?.pulse ?? 0, 0, 0, value?.source ?? 0];
    default:
      throw new Error(`unknown value type ${type}`);
  }
}

/** Bitmap of characteristic ids: [byteCount, ...bytes]. */
export function bitmap(ids) {
  if (!ids.length) return [0];
  const count = Math.floor(Math.max(...ids) / 8) + 1;
  const bytes = new Array(count).fill(0);
  for (const id of ids) bytes[id >> 3] |= 1 << (id & 7);
  return [count, ...bytes];
}

/** Ids set in a [byteCount, ...bytes] bitmap starting at `pos`. Returns { ids, next }. */
export function readBitmap(buf, pos) {
  const count = buf[pos] ?? 0;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const byte = buf[pos + 1 + i] ?? 0;
    for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) ids.push(i * 8 + bit);
  }
  return { ids, next: pos + 1 + count };
}

/** Raw command: 02 04 02 LL EE LL CC payload.. checksum */
export function buildRequest(equipment, command, payload = []) {
  const length = payload.length + 4;
  let checksum = equipment + length + command;
  for (const b of payload) checksum += b;
  return Uint8Array.from([2, 4, 2, length, equipment, length, command, ...payload, checksum & 0xff]);
}

/** Split a raw message into BLE writes: a 4-byte header then 20-byte chunks. */
export function frame(message) {
  const n = Math.ceil(message.length / CHUNK_PAYLOAD);
  const out = [Uint8Array.from([HEADER, 2, message.length, n + 1])];
  for (let i = 0; i < n; i++) {
    const part = message.subarray(i * CHUNK_PAYLOAD, (i + 1) * CHUNK_PAYLOAD);
    const chunk = new Uint8Array(20);
    chunk[0] = i === n - 1 ? EOF : i;
    chunk[1] = part.length;
    chunk.set(part, 2);
    out.push(chunk);
  }
  return out;
}

/** Rebuilds a message from framed chunks. push() returns the message on the final chunk. */
export class Reassembler {
  constructor() {
    this.buffer = null;
    this.chunks = 0;
  }

  push(chunk) {
    if (!chunk.length) throw new Error('empty chunk');
    if (chunk[0] === HEADER) {
      if (chunk.length < 4) throw new Error('short header chunk');
      this.buffer = new Uint8Array(chunk[2]);
      this.chunks = chunk[3] - 1;
      return null;
    }
    if (!this.buffer) throw new Error('data chunk before header');
    const index = chunk[0];
    const length = chunk[1];
    if (index !== EOF && index >= this.chunks) throw new Error(`chunk index ${index} out of range`);
    const pos = (index === EOF ? this.chunks - 1 : index) * CHUNK_PAYLOAD;
    if (pos + length > this.buffer.length) throw new Error('chunk overflows message');
    this.buffer.set(chunk.subarray(2, 2 + length), pos);
    if (index !== EOF) return null;
    const done = this.buffer;
    this.buffer = null;
    return done;
  }
}

export function checksumOk(message) {
  if (message.length <= 5) return true;
  let sum = 0;
  for (let i = 4; i < message.length - 1; i++) sum += message[i];
  return (sum & 0xff) === message[message.length - 1];
}

/** Validates a response and returns { equipment }. Throws on mismatch or error status. */
export function parseResponseHeader(response, expectedCommand) {
  if (response.length < 8) throw new Error('response too short');
  if (response.length !== response[3] + 4) throw new Error('response length mismatch');
  if (!checksumOk(response)) throw new Error('response checksum invalid');
  if (response[6] !== expectedCommand) {
    throw new Error(`expected command 0x${expectedCommand.toString(16)}, got 0x${response[6].toString(16)}`);
  }
  if (response[7] !== RESPONSE_OK) {
    const err = new Error(`equipment answered status ${response[7]}`);
    err.status = response[7];
    throw err;
  }
  return { equipment: response[4] };
}

/** Supported characteristic ids from an EQUIPMENT_INFORMATION response. */
export function parseEquipmentInformation(response) {
  return readBitmap(response, 16).ids;
}

/** Id list from SUPPORTED_CAPABILITIES / SUPPORTED_COMMANDS responses. */
export function parseIdList(response) {
  if (response.length < 9) return [];
  const count = Math.min(response[8], response.length - 9);
  return Array.from(response.subarray(9, 9 + count));
}

const ascii = (bytes) => String.fromCharCode(...bytes).replace(/[^\x20-\x7e]/g, '');

export function parseFirmware(response) {
  if (response.length < 12) return null;
  let end = 11;
  while (end < response.length && response[end] > 1) end++;
  return ascii(response.subarray(11, end)) || null;
}

export function parseReference(response) {
  return response.length < 19 ? null : readUint(response, 15, 4);
}

export function parseSerial(response) {
  if (response.length < 10) return null;
  const length = response[8];
  if (response.length < 9 + length) return null;
  return ascii(response.subarray(9, 9 + length)).trim() || null;
}

/**
 * Payload for WRITE_AND_READ: write bitmap, write values, read bitmap.
 * Only characteristics in `supported` (a Set of ids) are included.
 * Returns { payload, reads } where `reads` is the ordered list to decode the response with.
 */
export function buildWriteRead(supported, writes = {}, readNames = []) {
  const byId = (a, b) => a.def.id - b.def.id;
  const writeList = Object.entries(writes)
    .map(([name, value]) => ({ def: CHARS[name], value, name }))
    .filter((w) => {
      if (!w.def) throw new Error(`unknown characteristic ${w.name}`);
      if (!w.def.writable) throw new Error(`${w.name} is read-only`);
      return supported.has(w.def.id);
    })
    .sort(byId);
  const reads = readNames
    .map((name) => {
      if (!CHARS[name]) throw new Error(`unknown characteristic ${name}`);
      return { def: CHARS[name] };
    })
    .filter((r) => supported.has(r.def.id))
    .sort(byId)
    .map((r) => r.def);

  const payload = [
    ...bitmap(writeList.map((w) => w.def.id)),
    ...writeList.flatMap((w) => encodeValue(w.def.type, w.value)),
    ...bitmap(reads.map((d) => d.id)),
  ];
  return { payload, reads, written: writeList.map((w) => w.name) };
}

/** Decode the values of a WRITE_AND_READ response, given the ordered read list. */
export function parseReadValues(response, reads) {
  const out = {};
  let pos = 8;
  for (const def of reads) {
    const size = SIZES[def.type];
    if (pos + size > response.length - 1) break;
    out[def.name] = decodeValue(def.type, response, pos);
    pos += size;
  }
  return out;
}

export const sizeOf = (def) => SIZES[def.type];

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('hex string has an odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
