// Minimal asar reader: list / extract without external deps.
const fs = require('fs');
const path = require('path');

function readHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  // layout: [u32 4][u32 headerPickleLen][u32 headerPayloadLen][u32 jsonLen][json...][padding]
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSize = sizeBuf.readUInt32LE(4);
  const jsonSize = sizeBuf.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  return { fd, header, baseOffset: 8 + headerSize };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: Number(entry.size), offset: entry.offset === undefined ? undefined : Number(entry.offset), unpacked: !!entry.unpacked });
  }
}

function main() {
  const [cmd, archive, ...rest] = process.argv.slice(2);
  const { fd, header, baseOffset } = readHeader(archive);
  const files = [];
  walk(header, '', files);
  if (cmd === 'list') {
    const filter = rest[0] || '';
    const rows = files
      .filter((f) => f.path.includes(filter))
      .sort((a, b) => b.size - a.size);
    for (const f of rows) console.log(`${String(f.size).padStart(12)}  ${f.path}${f.unpacked ? '  [unpacked]' : ''}`);
    console.error(`total files: ${files.length}, shown: ${rows.length}, baseOffset: ${baseOffset}, minOffset: ${Math.min(...files.filter((f) => f.offset !== undefined).map((f) => f.offset))}`);
  } else if (cmd === 'find') {
    const re = new RegExp(rest[0]);
    for (const f of files.filter((x) => re.test(x.path))) console.log(`${String(f.size).padStart(12)}  ${f.path}`);
  } else if (cmd === 'cat') {
    const f = files.find((x) => x.path === rest[0]);
    if (!f) { console.error('not found: ' + rest[0]); process.exit(1); }
    if (f.unpacked) { console.error('unpacked file, read from app.asar.unpacked'); process.exit(1); }
    const buf = Buffer.alloc(Number(f.size));
    fs.readSync(fd, buf, 0, buf.length, baseOffset + Number(f.offset));
    process.stdout.write(buf);
  } else if (cmd === 'extract') {
    const f = files.find((x) => x.path === rest[0]);
    if (!f) { console.error('not found: ' + rest[0]); process.exit(1); }
    const out = rest[1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const buf = Buffer.alloc(Number(f.size));
    fs.readSync(fd, buf, 0, buf.length, baseOffset + Number(f.offset));
    fs.writeFileSync(out, buf);
    console.error(`wrote ${buf.length} bytes -> ${out}`);
  } else {
    console.error('usage: asar_tool.cjs list|find|cat|extract <archive> ...');
    process.exit(2);
  }
  fs.closeSync(fd);
}

main();
