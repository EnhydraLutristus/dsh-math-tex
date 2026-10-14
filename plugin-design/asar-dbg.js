const fs = require('fs');
const asarPath = process.argv[2];
const want = process.argv[3];
const fd = fs.openSync(asarPath, 'r');
const size = fs.fstatSync(fd).size;
console.log('asar size', size);
const head = Buffer.alloc(Math.min(16 * 1024 * 1024, size));
fs.readSync(fd, head, 0, head.length, 0);
console.log('u32@0', head.readUInt32LE(0), 'u32@4', head.readUInt32LE(4), 'u32@8', head.readUInt32LE(8), 'u32@12', head.readUInt32LE(12));
const start = head.indexOf('{"files":');
console.log('jsonStart(absolute)', start);
let end = -1, depth = 0, inStr = false, esc = false;
for (let i = start; i < head.length; i++) {
  const c = head[i];
  if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
  if (c === 34) inStr = true;
  else if (c === 123) depth++;
  else if (c === 125) { depth--; if (depth === 0) { end = i + 1; break; } }
}
const headerSize = head.readUInt32LE(12);
console.log('jsonEnd(absolute)', end, 'jsonLen', end - start, 'headerSizeField', headerSize);
const baseOffset = 16 + headerSize;
console.log('computed baseOffset', baseOffset, '=> jsonStart expected at', 16, 'actual', start, 'delta', start - 16);
const header = JSON.parse(head.toString('utf8', start, end));
const files = [];
(function walk(node, prefix) {
  for (const [name, e] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (e.files) walk(e, p); else files.push({ path: p, offset: Number(e.offset), size: e.size });
  }
})(header, '');
console.log('total files', files.length);
const f = files.find(x => x.path.includes(want));
if (!f) { console.log('not found:', want); process.exit(0); }
console.log('entry', JSON.stringify(f));
const buf = Buffer.alloc(f.size);
fs.readSync(fd, buf, 0, f.size, baseOffset + f.offset);
console.log('--- first 600 bytes ---');
console.log(JSON.stringify(buf.toString('utf8').slice(0, 600)));
