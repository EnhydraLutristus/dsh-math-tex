const { openAsar } = require('./asar-lib');
const A = openAsar("D:\\Deepseek\\resources\\app.asar");
let hits = 0;
for (const f of A.files.filter(f => /\.js$/.test(f.path))) {
  let buf; try { buf = A.read(f); } catch { continue; }
  if (buf.includes("markdown.truncatedCharacters")) {
    const lines = buf.split(/\r?\n/);
    lines.forEach((ln, i) => {
      if (ln.includes("markdown.truncatedCharacters")) {
        hits++;
        console.log(f.path + ":" + (i + 1));
      }
    });
  }
}
console.log("total referencing lines: " + hits);
