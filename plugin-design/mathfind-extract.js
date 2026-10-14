// mathfind-extract.js <asar> <entryPath> [outFile]
// Correct base: data section starts at the byte right after the header JSON's
// closing brace (jsonEnd). Verified empirically on this archive:
//   magic=16, strLen=3392048, jsonEnd=3392064; using 8+strLen=3392056 shifted
//   every extracted file by exactly 8 bytes.
const fs = require('fs');
const path = require('path');

const asarPath = process.argv[2];
const wanted = process.argv[3];
const out = process.argv[4];

const fd = fs.openSync(asarPath, 'r');
const size = fs.fstatSync(fd).size;
const head = Buffer.alloc(Math.min(size, 64 * 1024 * 1024));
fs.readSync(fd, head, 0, head.length, 0);

const magic = head.indexOf('{"files":');
if (magic < 0) throw new Error('asar header not found');
let depth = 0, i = magic, inStr = false, esc = false;
for (; i < head.length; i++) {
  const c = head[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === 0x5c) esc = true;
    else if (c === 0x22) inStr = false;
    continue;
  }
  if (c === 0x22) inStr = true;
  else if (c === 0x7b) depth++;
  else if (c === 0x7d) { depth--; if (depth === 0) { i++; break; } }
}
const header = JSON.parse(head.toString('utf8', magic, i));
const baseOffset = i;

const parts = wanted.replace(/^\/+/, '').split('/');
let node = header;
for (const part of parts) {
  if (!node.files || !node.files[part]) throw new Error('entry not found: ' + wanted);
  node = node.files[part];
}
if (node.files) {
  process.stdout.write('[directory] ' + Object.keys(node.files).join('  ') + '\n');
  process.exit(0);
}
const buf = Buffer.alloc(node.size);
fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.error('wrote ' + node.size + ' bytes -> ' + out);
} else {
  process.stdout.write(buf.toString('utf8'));
}
