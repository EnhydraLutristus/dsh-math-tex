const { openAsar } = require('./asar-lib');
const A = openAsar("D:\\Deepseek\\resources\\app.asar");
const hits = A.files.filter(f => /client-ui-(primitives|chat)\/lib\/.+\.js$/.test(f.path) && f.size > 50000);
for (const f of hits) {
  const buf = A.read(f);
  const def = (buf.match(/function renderTexToReact/g) || []).length;
  const krs = (buf.match(/katex\.renderToString/g) || []).length;
  console.log(`${String(f.size).padStart(9)}  def=${def} renderToString=${krs}  ${f.path}`);
}
