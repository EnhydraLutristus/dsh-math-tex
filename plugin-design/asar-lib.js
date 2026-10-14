// Shared asar reader helper.
const fs = require('fs');

function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(Math.min(16 * 1024 * 1024, size));
  fs.readSync(fd, head, 0, head.length, 0);
  const start = head.indexOf('{"files":');
  if (start < 0) throw new Error('no asar header found');
  let end = -1, depth = 0, inStr = false, esc = false;
  for (let i = start; i < head.length; i++) {
    const c = head[i];
    if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const headerSize = head.readUInt32LE(12);
  const baseOffset = 16 + headerSize;
  const header = JSON.parse(head.toString('utf8', start, end));
  const files = [];
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files || {})) {
      const p = prefix + '/' + name;
      if (e.files) walk(e, p); else files.push({ path: p, offset: Number(e.offset), size: e.size });
    }
  })(header, '');
  return {
    fd, baseOffset, files,
    read(entry) {
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, baseOffset + entry.offset);
      return buf.toString('utf8');
    },
  };
}
module.exports = { openAsar };
