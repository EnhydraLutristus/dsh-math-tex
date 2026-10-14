const { openAsar } = require('./asar-lib');
const A = openAsar("D:\\Deepseek\\resources\\app.asar");
const pats = [["MAX_CHARS", /const MAX_CHARS\s*=\s*[^;]+;/g],
              ["truncatedCharacters", /"markdown\.truncatedCharacters"[^,}]*/g],
              ["msgTruncate", /(text|content)\s*\.\s*(slice|substring)\(\s*0\s*,\s*[0-9e+*]{3,}/g]];
for (const f of A.files.filter(f => /\.(js|json)$/.test(f.path) && f.size > 20000 && f.size < 3000000)) {
  let buf; try { buf = A.read(f); } catch { continue; }
  for (const [label, re] of pats) {
    const m = buf.match(re);
    if (m) console.log(`[${label}] ${f.path}\n    ${[...new Set(m)].slice(0,3).join("\n    ")}`);
  }
}
