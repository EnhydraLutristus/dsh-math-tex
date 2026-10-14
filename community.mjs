const fs = await import('node:fs');
const data = JSON.parse(fs.readFileSync('dsh-plugins-survey.json', 'utf8'));
const cache = JSON.parse(fs.readFileSync('dl-cache.json', 'utf8'));

// retry the nulls once (many were transient rate-limit misses)
const nullNames = Object.entries(cache).filter(([, v]) => v == null).map(([k]) => k);
console.error(`retrying ${nullNames.length} null download lookups...`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function one(name) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`, {
        headers: { 'user-agent': 'dsh-plugin-survey' },
      });
      const t = await res.text();
      if (t.trimStart().startsWith('<')) throw new Error('html');
      const j = JSON.parse(t);
      return j.downloads ?? 0;
    } catch {
      await sleep(300 * (i + 1));
    }
  }
  return null;
}
let i = 0;
async function worker(q) {
  while (q.length) {
    const n = q.shift();
    const v = await one(n);
    if (v != null) cache[n] = v;
    if (++i % 50 === 0) {
      fs.writeFileSync('dl-cache.json', JSON.stringify(cache));
      console.error(`  retry ${i}/${nullNames.length}`);
    }
    await sleep(50);
  }
}
const q = [...nullNames];
await Promise.all(Array.from({ length: 6 }, () => worker(q)));
fs.writeFileSync('dl-cache.json', JSON.stringify(cache));

const community = data.candidates
  .filter((c) => !c.name.startsWith('@deepseek-ai/'))
  .map((c) => ({ ...c, downloadsLastMonth: cache[c.name] ?? null }));

// community plugin heuristics
const isPlugin = (c) => c.name !== '@dsh-plus/shared' && !/catalog|feed|cli$/.test(c.name);
const score = (c) => (c.downloadsLastMonth ?? 0) + (c.stars ?? 0) * 20;

const rows = community.filter(isPlugin).sort((a, b) => score(b) - score(a));
console.log(`community candidates with downloads: ${community.filter((c) => c.downloadsLastMonth > 0).length} / ${community.length}`);
console.log('\n=== COMMUNITY TOP 70 ===');
for (const c of rows.slice(0, 70)) {
  console.log(
    `${String(c.downloadsLastMonth ?? '-').padStart(8)} | ${String(c.stars ?? '-').padStart(5)}* | ${c.name}@${c.version} | ${(c.repo ?? '-').padEnd(40)} | ${c.desc.slice(0, 120)}`
  );
}
