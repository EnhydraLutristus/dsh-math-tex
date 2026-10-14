const urls = [
  'https://api.npmjs.org/downloads/point/last-month/dsh-plugin',
  'https://api.npmjs.org/downloads/point/last-month/dsh-plugin-whale-pet',
  'https://registry.npmmirror.com/downloads/point/last-month/dsh-plugin',
  'https://registry.npmjs.org/dsh-plugin',
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'dsh-plugin-survey' } });
    const t = await r.text();
    console.log(`\n=== ${u} -> ${r.status} ${r.headers.get('content-type')} len=${t.length}`);
    console.log(t.slice(0, 300).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`\n=== ${u} -> ERR ${e}`);
  }
}
