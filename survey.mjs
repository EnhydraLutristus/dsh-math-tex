// DSH plugin popularity survey: npm search -> download counts (parallel, resumable) -> GitHub stars.
const fs = await import('node:fs');

const QUERIES = ['dsh-plugin', 'dsh plugin', 'deepseek-harness plugin', 'dsh-plugin deepseek', 'keywords:dsh-plugin', 'dsh 插件', 'dsh cordis plugin'];
const CACHE_FILE = 'dl-cache.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dlCache = {};
try { dlCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}

async function fetchJson(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-survey', accept: 'application/json' } });
      const text = await res.text();
      if (text.trimStart().startsWith('<')) throw new Error('HTML response (rate limited?)');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await sleep(400 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ---------- 1. search ----------
const seen = new Map();
for (const q of QUERIES) {
  try {
    const j = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250`);
    for (const o of j.objects ?? []) {
      const p = o.package;
      if (!p?.name) continue;
      const e = seen.get(p.name);
      if (e) e.searchScore = Math.max(e.searchScore, o.searchScore ?? 0);
      else
        seen.set(p.name, {
          name: p.name,
          version: p.version,
          date: p.date,
          desc: (p.description ?? '').replace(/\s+/g, ' ').slice(0, 240),
          keywords: p.keywords ?? [],
          repo: p.links?.repository ?? '',
          homepage: p.links?.homepage ?? '',
          publisher: typeof p.publisher === 'object' ? p.publisher?.username ?? '' : p.publisher ?? '',
          searchScore: o.searchScore ?? 0,
        });
    }
    console.error(`search "${q}" -> ${seen.size} unique`);
  } catch (e) {
    console.error(`search "${q}" FAILED ${e}`);
  }
}

const isDshish = (c) => {
  const n = c.name.toLowerCase();
  if (n.startsWith('@deepseek-ai/dsh')) return true;
  if (n.includes('dsh-plugin') || n.includes('dshmarket') || n.includes('dsh-market')) return true;
  if (/^(@[^/]+\/)?dsh[-.]/.test(n)) return true;
  if ((c.keywords ?? []).some((k) => String(k).toLowerCase().includes('dsh'))) return true;
  return false;
};
const candidates = [...seen.values()].filter(isDshish);
console.error(`candidates: ${candidates.length}`);

// ---------- 2. downloads, parallel with incremental cache ----------
const pending = candidates.filter((c) => !(c.name in dlCache));
console.error(`download lookups pending: ${pending.length} (cached ${candidates.length - pending.length})`);

let done = 0;
async function worker(queue) {
  while (queue.length) {
    const c = queue.shift();
    try {
      const j = await fetchJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(c.name)}`);
      dlCache[c.name] = j.downloads ?? null;
    } catch {
      dlCache[c.name] = null;
    }
    done++;
    if (done % 25 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(dlCache));
      console.error(`  downloads ${done}/${pending.length}`);
    }
    await sleep(60);
  }
}
const queue = [...pending];
await Promise.all(Array.from({ length: 6 }, () => worker(queue)));
fs.writeFileSync(CACHE_FILE, JSON.stringify(dlCache));

for (const c of candidates) c.downloadsLastMonth = dlCache[c.name] ?? null;
candidates.sort((a, b) => (b.downloadsLastMonth ?? -1) - (a.downloadsLastMonth ?? -1));

// ---------- 3. GitHub stars ----------
function parseRepo(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

const repoMeta = new Map();
async function ghRepo(full) {
  if (repoMeta.has(full)) return repoMeta.get(full);
  try {
    const j = await fetchJson(`https://api.github.com/repos/${full}`);
    const info = { stars: j.stargazers_count, forks: j.forks_count, pushedAt: j.pushed_at, url: j.html_url, desc: (j.description ?? '').slice(0, 200) };
    repoMeta.set(full, info);
    return info;
  } catch {
    repoMeta.set(full, null);
    return null;
  }
}

// topic listing gives stars in bulk for the most popular repos
try {
  for (let page = 1; page <= 2; page++) {
    const j = await fetchJson(`https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=100&page=${page}`);
    for (const r of j.items ?? []) {
      repoMeta.set(r.full_name, { stars: r.stargazers_count, forks: r.forks_count, pushedAt: r.pushed_at, url: r.html_url, desc: (r.description ?? '').slice(0, 200) });
    }
    await sleep(1500);
  }
  console.error(`topic repos cached: ${repoMeta.size}`);
} catch (e) {
  console.error(`topic listing failed: ${e}`);
}

// only look up repos for candidates that matter (downloads > 0 or top 250 by score)
const toLookup = candidates.filter((c, i) => (c.downloadsLastMonth ?? 0) > 0 || i < 250);
let ghDone = 0;
const ghQueue = toLookup.map((c) => parseRepo(c.repo) ?? parseRepo(c.homepage)).filter(Boolean);
const uniqueRepos = [...new Set(ghQueue)].filter((r) => !repoMeta.has(r));
console.error(`github repo lookups: ${uniqueRepos.length}`);
async function ghWorker(q) {
  while (q.length) {
    const full = q.shift();
    await ghRepo(full);
    ghDone++;
    if (ghDone % 25 === 0) console.error(`  gh ${ghDone}/${uniqueRepos.length} (cache ${repoMeta.size})`);
    await sleep(120);
  }
}
const ghQ = [...uniqueRepos];
await Promise.all(Array.from({ length: 5 }, () => ghWorker(ghQ)));

for (const c of candidates) {
  const repo = parseRepo(c.repo) ?? parseRepo(c.homepage);
  const info = repo ? repoMeta.get(repo) ?? null : null;
  c.repo = repo;
  c.stars = info?.stars ?? null;
  c.repoPushedAt = info?.pushedAt ?? null;
  c.repoUrl = info?.url ?? (repo ? `https://github.com/${repo}` : null);
  c.repoDesc = info?.desc ?? null;
}

fs.writeFileSync(
  'dsh-plugins-survey.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), totalScanned: seen.size, candidateCount: candidates.length, candidates }, null, 1)
);
console.log(`OK scanned=${seen.size} candidates=${candidates.length} withDownloads=${candidates.filter((c) => c.downloadsLastMonth > 0).length} withStars=${candidates.filter((c) => c.stars != null).length}`);
