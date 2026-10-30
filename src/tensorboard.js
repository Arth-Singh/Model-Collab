import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A minimal TensorBoard event writer with no dependencies: scalars only. An
// event file is a sequence of TFRecords, each a length, a masked CRC32C of the
// length, an `Event` protobuf, and a masked CRC32C of the protobuf.

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli), the checksum TFRecord uses. */
export function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const masked = (crc) => (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;

function varint(value) {
  const bytes = [];
  let n = Math.floor(value);
  while (n > 0x7f) {
    bytes.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

const field = (number, wireType) => varint(number * 8 + wireType);
const bytesField = (number, payload) =>
  Buffer.concat([field(number, 2), varint(payload.length), payload]);

function record(payload) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(payload.length));
  const lengthCrc = Buffer.alloc(4);
  lengthCrc.writeUInt32LE(masked(crc32c(length)));
  const dataCrc = Buffer.alloc(4);
  dataCrc.writeUInt32LE(masked(crc32c(payload)));
  return Buffer.concat([length, lengthCrc, payload, dataCrc]);
}

/** An `Event` with wall time, step, and either a file version or a summary. */
function event({ wallTime, step = 0, fileVersion, summary }) {
  const time = Buffer.alloc(8);
  time.writeDoubleLE(wallTime);
  const parts = [field(1, 1), time];
  if (step) parts.push(field(2, 0), varint(step));
  if (fileVersion) parts.push(bytesField(3, Buffer.from(fileVersion)));
  if (summary) parts.push(bytesField(5, summary));
  return Buffer.concat(parts);
}

/** A `Summary` of scalar values: tag (field 1) and simple_value (field 2, a float). */
function summary(values) {
  return Buffer.concat(
    values.map(([tag, value]) => {
      const number = Buffer.alloc(4);
      number.writeFloatLE(value);
      return bytesField(1, Buffer.concat([bytesField(1, Buffer.from(tag)), field(2, 5), number]));
    }),
  );
}

export class EventWriter {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const seconds = Math.floor(Date.now() / 1000);
    this.file = path.join(dir, `events.out.tfevents.${seconds}.${os.hostname()}.${process.pid}`);
    this.fd = fs.openSync(this.file, 'a');
    this.write(event({ wallTime: Date.now() / 1000, fileVersion: 'brain.Event:2' }));
  }

  write(payload) {
    fs.writeSync(this.fd, record(payload));
  }

  /** Record scalars at one step. Non-finite values are skipped. */
  scalars(values, step, wallTime = Date.now() / 1000) {
    const finite = Object.entries(values).filter(([, value]) => Number.isFinite(value));
    if (finite.length) this.write(event({ wallTime, step, summary: summary(finite) }));
  }

  close() {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
  }
}
