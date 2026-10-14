// Enrich DSH plugin candidates with GitHub stars, using Search API repo mapping.
const fs = await import('node:fs');

const npm = JSON.parse(fs.readFileSync('dsh-plugins-npm.json', 'utf8'));
const candidates = npm.candidates;
const errors = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      headers: { 'user-agent': 'dsh-plugin-survey', accept: 'application/vnd.github+json' },
    });
    if (res.status === 403 || res.status === 429) {
      await sleep(3000 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }
  throw new Error('rate limited');
}

// 1) topic listing
const repos = [];
for (let page = 1; page <= 3; page++) {
  try {
    const j = await gh(`https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=100&page=${page}`);
    for (const r of j.items ?? []) {
      repos.push({
        full_name: r.full_name,
        stars: r.stargazers_count,
        forks: r.forks_count,
        desc: (r.description ?? '').slice(0, 200),
        pushed_at: r.pushed_at,
        topics: r.topics ?? [],
        homepage: r.homepage ?? '',
        html_url: r.html_url,
      });
    }
    await sleep(1200);
  } catch (e) {
    errors.push({ step: `topic page ${page}`, error: String(e) });
  }
}
console.error(`topic repos: ${repos.length}`);

// 2) map candidate -> repo
function parseRepo(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}
const byRepo = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
const repoCache = new Map();
for (const r of repos) repoCache.set(r.full_name.toLowerCase(), r);

const enriched = [];
for (const c of candidates) {
  let repo = parseRepo(c.repo) ?? parseRepo(c.homepage);
  let ghInfo = repo ? repoCache.get(repo.toLowerCase()) ?? null : null;
  if (repo && !ghInfo) {
    try {
      const j = await gh(`https://api.github.com/repos/${repo}`);
      ghInfo = {
        full_name: j.full_name,
        stars: j.stargazers_count,
        forks: j.forks_count,
        desc: (j.description ?? '').slice(0, 200),
        pushed_at: j.pushed_at,
        topics: j.topics ?? [],
        homepage: j.homepage ?? '',
        html_url: j.html_url,
      };
      repoCache.set(repo.toLowerCase(), ghInfo);
    } catch (e) {
      errors.push({ step: `repo ${repo}`, error: String(e) });
    }
    await sleep(350);
  }
  enriched.push({
    ...c,
    repo,
    stars: ghInfo?.stars ?? null,
    repoPushedAt: ghInfo?.pushed_at ?? null,
    repoDesc: ghInfo?.desc ?? null,
    repoUrl: ghInfo?.html_url ?? (repo ? `https://github.com/${repo}` : null),
  });
}

// 3) repos in topic that are not matched to any npm candidate (informational)
const matched = new Set(enriched.map((e) => (e.repo ?? '').toLowerCase()).filter(Boolean));
const topicOnly = repos.filter((r) => !matched.has(r.full_name.toLowerCase()));

fs.writeFileSync(
  'dsh-plugins-enriched.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), errors, candidates: enriched, topicOnly }, null, 1)
);
console.log(`enriched ${enriched.length} candidates; topic-only repos ${topicOnly.length}`);
