// list-asar.js — 解析 Electron asar 头部（不依赖 npm 包），只打印命中的路径
const fs = require("fs");
const target = process.argv[2];
const filter = process.argv[3] ? new RegExp(process.argv[3], "i") : null;
const limit = Number(process.argv[4] || 200);

const fd = fs.openSync(target, "r");
const fileSize = fs.fstatSync(fd).size;
const cap = Math.min(fileSize, 64 << 20);            // 头部可能远超 4 MB
const head = Buffer.alloc(cap);
const n = fs.readSync(fd, head, 0, cap, 0);
fs.closeSync(fd);

const start = head.indexOf('{"files":');
if (start < 0) { console.error("未找到 asar 头部"); process.exit(1); }

// asar 头部是 pickle：8 字节前导 + 4 字节长度 + JSON。先按声明长度精确切片，
// 失败则按括号配平找到真正的结尾（NUL 填充不能作为界标）。
let header;
const declared = head.readUInt32LE(start - 4);
try {
  header = JSON.parse(head.toString("utf8", start, start + declared));
} catch {
  let depth = 0, inStr = false, esc = false, endPos = -1;
  for (let i = start; i < n; i++) {
    const c = head[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125) { depth--; if (depth === 0) { endPos = i + 1; break; } }
  }
  if (endPos < 0) { console.error(`头部未闭合（已读 ${n} / 共 ${fileSize} 字节）`); process.exit(1); }
  header = JSON.parse(head.toString("utf8", start, endPos));
}

const hits = [];
let total = 0;
(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix + "/" + name;
    if (val.files) walk(val, p);
    else {
      total++;
      if (!filter || filter.test(p)) hits.push(`${val.size || 0}\t${p}`);
    }
  }
})(header, "");

console.log(`文件总数 ${total}，命中 ${hits.length}${limit < hits.length ? `（只显示前 ${limit}）` : ""}`);
console.log(hits.slice(0, limit).join("\n"));
