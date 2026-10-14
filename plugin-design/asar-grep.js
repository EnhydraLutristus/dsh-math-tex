// asar-grep.js <asar> <pathRegex> <contentRegex> [maxHitsPerFile] [maxFiles] [contextLines]
const { openAsar } = require('./asar-lib');
const [, , asarPath, pathRe, contentRe, maxHitsArg, maxFilesArg, ctxArg] = process.argv;
const maxHits = Number(maxHitsArg || 6);
const maxFiles = Number(maxFilesArg || 40);
const ctxN = Number(ctxArg || 0);
const A = openAsar(asarPath);
const pre = new RegExp(pathRe);
const cre = new RegExp(contentRe);
let shown = 0, totalHits = 0;
for (const f of A.files) {
  if (!pre.test(f.path)) continue;
  if (shown >= maxFiles) break;
  if (!Number.isFinite(f.offset) || f.size === 0 || f.size > 24 * 1024 * 1024) continue;
  const text = A.read(f);
  if (text.indexOf('\u0000') !== -1) continue; // binary
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (cre.test(lines[i])) hits.push(i);
  if (!hits.length) continue;
  shown++; totalHits += hits.length;
  console.log('\n===== ' + f.path + ' (' + f.size + 'B, ' + lines.length + ' lines, ' + hits.length + ' hits) =====');
  for (const i of hits.slice(0, maxHits)) {
    const a = Math.max(0, i - ctxN), b = Math.min(lines.length - 1, i + ctxN);
    for (let j = a; j <= b; j++) console.log(String(j + 1).padStart(5) + (j === i ? ': ' : '| ') + lines[j].slice(0, 400));
    if (ctxN) console.log('      --');
  }
  if (hits.length > maxHits) console.log('   ...(' + (hits.length - maxHits) + ' more hits)');
}
console.log('\n[files shown: ' + shown + ' | total hits: ' + totalHits + ']');
