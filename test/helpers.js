import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc32c } from '../src/tensorboard.js';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  );

/** A temporary Git project with one commit, removed after the test. */
export async function gitProject(
  t,
  prefix = 'model-collab-',
  files = { 'README.md': 'Project\n' },
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initGit(root, files);
  return root;
}

/** Turn an existing directory into a Git project with one commit. */
export async function initGit(root, files = { 'README.md': 'Project\n' }) {
  await writeFiles(root, files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
}

export async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
}

// A TensorBoard event-file reader written apart from the writer, for tests.
const unmask = (value) => {
  const rotated = (value - 0xa282ead8) >>> 0;
  return ((rotated >>> 17) | (rotated << 15)) >>> 0;
};

function readVarint(buffer, at) {
  let value = 0,
    scale = 1,
    byte;
  do {
    byte = buffer[at++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, at];
}

/** Protobuf fields of one message: [number, wireType, value] in order. */
function fields(buffer) {
  const out = [];
  let at = 0;
  while (at < buffer.length) {
    let key;
    [key, at] = readVarint(buffer, at);
    const number = Math.floor(key / 8),
      type = key % 8;
    if (type === 0) {
      let value;
      [value, at] = readVarint(buffer, at);
      out.push([number, type, value]);
    } else if (type === 1) {
      out.push([number, type, buffer.readDoubleLE(at)]);
      at += 8;
    } else if (type === 5) {
      out.push([number, type, buffer.readFloatLE(at)]);
      at += 4;
    } else if (type === 2) {
      let length;
      [length, at] = readVarint(buffer, at);
      out.push([number, type, buffer.subarray(at, at + length)]);
      at += length;
    } else throw new Error(`wire type ${type}`);
  }
  return out;
}

/** Every event in a file, checking each record's checksums along the way. */
export async function readEvents(file) {
  const data = await fs.readFile(file);
  const events = [];
  for (let at = 0; at < data.length;) {
    const length = Number(data.readBigUInt64LE(at));
    if (unmask(data.readUInt32LE(at + 8)) !== crc32c(data.subarray(at, at + 8)))
      throw new Error('bad length checksum');
    const payload = data.subarray(at + 12, at + 12 + length);
    if (unmask(data.readUInt32LE(at + 12 + length)) !== crc32c(payload))
      throw new Error('bad data checksum');
    const event = { scalars: {} };
    for (const [number, , value] of fields(payload)) {
      if (number === 1) event.wallTime = value;
      if (number === 2) event.step = value;
      if (number === 3) event.fileVersion = value.toString();
      if (number === 5)
        for (const [, , entry] of fields(value)) {
          const parts = Object.fromEntries(fields(entry).map(([n, , v]) => [n, v]));
          event.scalars[parts[1].toString()] = parts[2];
        }
    }
    events.push(event);
    at += 16 + length;
  }
  return events;
}

/** Every scalar event in a TensorBoard run folder. */
export async function scalarsIn(dir) {
  const files = (await fs.readdir(dir)).filter((name) => name.includes('tfevents'));
  const events = (await Promise.all(files.map((f) => readEvents(path.join(dir, f))))).flat();
  return events.filter((e) => Object.keys(e.scalars).length);
}
