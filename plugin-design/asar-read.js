// asar-read.js <asar> <pathSuffixOrRegex> [startLine] [endLine]
const { openAsar } = require('./asar-lib');
const [, , asarPath, want, sArg, eArg] = process.argv;
const A = openAsar(asarPath);
let f = A.files.find(x => x.path === want);
if (!f) f = A.files.find(x => x.path.endsWith(want));
if (!f) { const re = new RegExp(want); const c = A.files.filter(x => re.test(x.path)); console.log('candidates:', c.map(x => x.path).join('\n')); process.exit(1); }
console.log('### ' + f.path + '  (' + f.size + 'B)');
const lines = A.read(f).split(/\r?\n/);
const s = Math.max(1, Number(sArg || 1)), e = Math.min(lines.length, Number(eArg || 400));
for (let i = s; i <= e; i++) console.log(String(i).padStart(5) + ': ' + lines[i - 1].slice(0, 20000));
console.log('### total lines: ' + lines.length);

