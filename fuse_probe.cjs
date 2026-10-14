// Locate the Electron fuse wire in the executable and decode fuse states.
const fs = require('fs');
const exe = process.argv[2];
const WIRE = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges'
];
const fd = fs.openSync(exe, 'r');
const CHUNK = 8 * 1024 * 1024;
const overlap = WIRE.length + 32;
let pos = 0;
let carry = Buffer.alloc(0);
const hits = [];
while (true) {
  const buf = Buffer.alloc(CHUNK);
  const read = fs.readSync(fd, buf, 0, CHUNK, pos);
  if (read <= 0) break;
  const data = Buffer.concat([carry, buf.subarray(0, read)]);
  let idx = data.indexOf(WIRE);
  while (idx !== -1) {
    hits.push({ fileOffset: pos - carry.length + idx, data, idx });
    idx = data.indexOf(WIRE, idx + 1);
  }
  carry = data.subarray(Math.max(0, data.length - overlap));
  pos += read;
  if (read < CHUNK) break;
}
console.log('exe size:', fs.statSync(exe).size);
console.log('wire hits:', hits.length);
for (const hit of hits) {
  const after = hit.data.subarray(hit.idx + WIRE.length, hit.idx + WIRE.length + 64);
  console.log('fileOffset', hit.fileOffset, 'bytes:', after.subarray(0, 24).toString('hex'));
  after.forEach((b, i) => {
    if (i % 2 === 1 && i < FUSES.length * 2) console.log(`  ${FUSES[(i - 1) / 2] ?? 'fuse' + i}: ${b}`);
  });
  break;
}
