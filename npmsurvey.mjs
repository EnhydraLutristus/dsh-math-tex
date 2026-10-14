const QUERIES = ['dsh-plugin', 'dsh plugin', 'deepseek-harness plugin', 'dsh-plugin deepseek', 'keywords:dsh-plugin', 'dsh 插件'];
const seen = new Map();
const errors = [];

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-survey' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

for (const q of QUERIES) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250`;
  try {
    const json = await getJson(url);
    for (const o of json.objects ?? []) {
      const p = o.package;
      if (!p?.name) continue;
      const prev = seen.get(p.name);
      const entry = {
        name: p.name,
        version: p.version,
        date: p.date,
        desc: (p.description ?? '').replace(/\s+/g, ' ').slice(0, 220),
        keywords: p.keywords ?? [],
        repo: p.links?.repository ?? '',
        homepage: p.links?.homepage ?? '',
        npmUrl: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
        publisher: p.publisher?.username ?? '',
        searchScore: o.searchScore ?? 0,
        fromQuery: [q],
      };
      if (prev) {
        prev.searchScore = Math.max(prev.searchScore, entry.searchScore);
        prev.fromQuery.push(q);
      } else seen.set(p.name, entry);
    }
    console.error(`query "${q}" ok, cumulative candidates ${seen.size}`);
  } catch (e) {
    errors.push({ q, error: String(e) });
    console.error(`query "${q}" FAILED: ${e}`);
  }
}

// scope candidates
const isDshish = (name, kw) => {
  const n = name.toLowerCase();
  if (n.startsWith('@deepseek-ai/dsh')) return true;
  if (n.includes('dsh-plugin') || n.includes('/dsh-') || n.startsWith('dsh-plugin')) return true;
  if (/^dsh-/.test(n)) return true;
  if ((kw ?? []).some((k) => String(k).toLowerCase().includes('dsh'))) return true;
  return false;
};

const candidates = [...seen.values()].filter((c) => isDshish(c.name, c.keywords));
console.error(`candidates kept: ${candidates.length} of ${seen.size}`);

// downloads
const dl = {};
for (const c of candidates) {
  try {
    const j = await getJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(c.name).replace('%40', '@')}`);
    dl[c.name] = j.downloads ?? null;
  } catch (e) {
    dl[c.name] = null;
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  errors,
  totalScanned: seen.size,
  candidateCount: candidates.length,
  candidates: candidates
    .map((c) => ({ ...c, downloadsLastMonth: dl[c.name] ?? null }))
    .sort((a, b) => (b.downloadsLastMonth ?? -1) - (a.downloadsLastMonth ?? -1)),
};

const fs = await import('node:fs');
fs.writeFileSync('dsh-plugins-npm.json', JSON.stringify(out, null, 1));
console.log(`wrote dsh-plugins-npm.json with ${out.candidates.length} candidates`);
