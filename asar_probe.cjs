const fs = require('fs');
const archive = process.argv[2];
const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(64);
fs.readSync(fd, head, 0, 64, 0);
console.log('first64hex:', head.toString('hex').match(/../g).join(' '));
console.log('first64asc:', JSON.stringify(head.toString('latin1')));
const a = head.readUInt32LE(0);
const b = head.readUInt32LE(4);
console.log('u32@0:', a, 'u32@4:', b);
// try both candidate readings
for (const [label, hdrOff, sizeOff] of [['A', 8, 4], ['B', 4, 0]]) {
  try {
    const buf = Buffer.alloc(Math.min(b, 4096));
    fs.readSync(fd, buf, 0, buf.length, hdrOff);
    console.log(label, 'raw:', JSON.stringify(buf.toString('latin1').slice(0, 80)));
  } catch (e) { console.log(label, 'err', e.message); }
}
