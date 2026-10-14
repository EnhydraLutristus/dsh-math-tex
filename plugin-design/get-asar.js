// get-asar.js <asar> <entryPath> [maxBytes]
// Prints the raw text of one entry inside an asar archive.
const fs = require('fs');

const asarPath = process.argv[2];
const wanted = process.argv[3];
const maxBytes = Number(process.argv[4] || 400000);

const hiddenSanityCheck = (baseOffset, magic) => baseOffset >= magic && baseOffset < magic + 64 * 1024 * 1024;

const fd = fs.openSync(asarPath, 'r');
const size = fs.fstatSync(fd).size;
const head = Buffer.alloc(Math.min(size, 32 * 1024 * 1024));
fs.readSync(fd, head, 0, head.length, 0);

const magic = head.indexOf('{"files":');
if (magic < 0) throw new Error('asar header not found');
// bracket-match the JSON header, respecting strings + escapes
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
// headerSize is a uint32 stored 4 bytes before the JSON, in the pickle payload
const headerBufLen = head.readUInt32LE(4);
const baseOffset = 8 + headerBufLen;
if (hiddenSanityCheck(baseOffset, magic) === false) throw new Error('header math wrong');

const parts = wanted.replace(/^\//, '').split('/');
let node = header;
for (const part of parts) {
  if (!node.files || !node.files[part]) throw new Error('entry not found: ' + wanted);
  node = node.files[part];
}
if (node.files) {
  console.log('[directory] ' + Object.keys(node.files).join('  '));
  process.exit(0);
}
const len = Math.min(node.size, maxBytes);
const buf = Buffer.alloc(len);
fs.readSync(fd, buf, 0, len, baseOffset + Number(node.offset));
process.stdout.write(buf.toString('utf8'));
if (node.size > len) console.log('\n[...truncated at ' + len + ' of ' + node.size + ' bytes]');
