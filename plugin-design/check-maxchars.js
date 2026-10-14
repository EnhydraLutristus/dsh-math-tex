const { openAsar } = require('./asar-lib');
const A = openAsar("D:\\Deepseek\\resources\\app.asar");
for (const p of ["/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js",
                 "/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"]) {
  const f = A.files.find(x => x.path === p);
  const lines = A.read(f).split(/\r?\n/);
  console.log("=== " + p + " (" + lines.length + " lines) ===");
  lines.forEach((ln, i) => {
    if (/MAX_CHARS/.test(ln)) {
      const a = Math.max(0, i - 10), b = Math.min(lines.length, i + 5);
      for (let k = a; k < b; k++) console.log(String(k + 1).padStart(6) + ": " + lines[k].slice(0, 180));
      console.log("  ---");
    }
  });
}
