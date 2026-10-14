const queries = process.argv.slice(2);
const out = [];
for (const q of queries) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=100`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-survey' } });
    const json = await res.json();
    for (const o of json.objects ?? []) {
      out.push({
        query: q,
        name: o.package.name,
        version: o.package.version,
        date: o.package.date,
        desc: (o.package.description ?? '').slice(0, 160),
        keywords: o.package.keywords ?? [],
        links: o.package.links ?? {},
        score: o.score?.final,
        downloads: o.downloads ?? null,
      });
    }
  } catch (e) {
    out.push({ query: q, error: String(e) });
  }
}
console.log(JSON.stringify(out, null, 1));
