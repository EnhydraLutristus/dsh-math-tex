// Verify shortlist: latest version, publish date, weekly downloads for the 10 picks.
const picks = [
  'dsh-better-sidebar',
  'dshmarket',
  '@michengai/dsh-codex-ui',
  'dsh-cost-meter',
  '@linxin666/dsh-remote-web-ui',
  'dsh-pocket',
  '@nanmicoder/dsh-agent-teams',
  'dsh-find-plugin',
  'dsh-context',
  '@liustack/modsearch',
  '@michengai/dsh-skills-manager',
  'dsh-my-guardian',
];

async function j(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-survey' } });
      const t = await r.text();
      if (t.trimStart().startsWith('<')) throw new Error('html');
      return JSON.parse(t);
    } catch {
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  return null;
}

for (const p of picks) {
  const meta = await j(`https://registry.npmjs.org/${p.replace('/', '%2f')}`);
  const wk = await j(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(p)}`);
  const mo = await j(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(p)}`);
  if (!meta) {
    console.log(`${p}: META FAIL`);
    continue;
  }
  const latest = meta['dist-tags']?.latest;
  const v = meta.versions?.[latest] ?? {};
  console.log(
    `${p}\n   latest=${latest} published=${meta.time?.[latest]} weekly=${wk?.downloads ?? '-'} monthly=${mo?.downloads ?? '-'} license=${v.license ?? '-'} deps=${Object.keys(v.dependencies ?? {}).length} repo=${(v.repository?.url ?? meta.repository?.url ?? '-')}`
  );
}
