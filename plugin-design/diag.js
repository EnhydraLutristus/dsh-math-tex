// diag.js — 校准 asar 数据区起点
const fs = require('fs');
const p = process.argv[2];
const fd = fs.openSync(p, 'r');
const head = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 64 << 20));
fs.readSync(fd, head, 0, head.length, 0);
const magic = head.indexOf('{"files":');
const strLen = head.readUInt32LE(magic - 4);
let depth = 0, i = magic, inStr = false, esc = false;
for (; i < head.length; i++) {
  const c = head[i];
  if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
  if (c === 34) inStr = true;
  else if (c === 123) depth++;
  else if (c === 125) { depth--; if (depth === 0) { i++; break; } }
}
console.log('magic=', magic, 'strLen=', strLen, 'jsonEnd=', i, 'jsonLen=', i - magic, 'tail=', i - magic - strLen);
const h = JSON.parse(head.toString('utf8', magic, i));
const zero = [];
(function w(n, pre) {
  for (const [k, v] of Object.entries(n.files || {})) {
    const q = pre + '/' + k;
    if (v.files) w(v, q);
    else if (Number(v.offset) === 0) zero.push(q + ' size=' + v.size);
  }
})(h, '');
console.log('offset0 entries:', zero.slice(0, 8).join(' | '));
