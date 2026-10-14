const fs = await import('node:fs');
const data = JSON.parse(fs.readFileSync('dsh-plugins-survey.json', 'utf8'));
const { candidates } = data;

const cache = JSON.parse(fs.readFileSync('dl-cache.json', 'utf8'));
const nulls = Object.entries(cache).filter(([, v]) => v == null).length;
console.log(`cache entries=${Object.keys(cache).length} nulls=${nulls}`);

const score = (c) => (c.downloadsLastMonth ?? 0) + (c.stars ?? 0) * 20;

const top = [...candidates].sort((a, b) => score(b) - score(a)).slice(0, 60);
console.log('\n=== TOP 60 by combined score (dl + stars*20) ===');
for (const c of top) {
  console.log(
    `${String(c.downloadsLastMonth ?? '-').padStart(8)} dl | ${String(c.stars ?? '-').padStart(6)}★ | ${c.name}@${c.version} | ${(c.repo ?? '').padEnd(42)} | ${c.desc.slice(0, 110)}`
  );
}

console.log('\n=== TOP 40 by stars ===');
for (const c of [...candidates].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1)).slice(0, 40)) {
  console.log(`${String(c.stars ?? '-').padStart(6)}★ | ${String(c.downloadsLastMonth ?? '-').padStart(7)} dl | ${c.name} | ${(c.repo ?? '').padEnd(42)} | ${c.desc.slice(0, 100)}`);
}
