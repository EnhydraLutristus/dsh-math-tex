// Quick: download counts for the top candidates from the first npm search page (by npm search score).
const names = [
  'dsh-plugin', 'dsh-plugin-shop-catalog', 'dsh-plugin-om', 'dsh-plugin-model-proxy',
  'create-dsh-plugin-cli', 'dsh-plugin-ops-core', 'dsh-plugin-guide', 'dsh-plugin-appshot',
  'dsh-find-plugin', 'aiko-dsh-plugin-catalog', 'dsh-plugin-ops-bundle', 'awesome-dsh-plugin-feed',
  'dsh-plugin-observatory', 'dsh-context-milvus', 'dsh-plugin-marketplace', '@goodandready/dsh-time-machine',
  'dsh-plugin-studio', 'dsh-electro-lab', 'dsh-plugin-mgr', 'dsh-plugin-tool-management',
  '@goodandready/dsh-context-lens', '@dsh-cc/plugin-loader', '@dhicoc/dsh-chinese-traditional-wisdom-skill',
  '@goodandready/dsh-shadow-auditor', 'dsh-plan-and-execute', '@huanlin/dsh-plugin-mineru',
  'dsh-aimail', '@goodandready/dsh-plugin-notify', '@oh-story/dsh', 'dsh-plugin-console',
  'dsh-plugin-uisfx', '@jw-king/dsh-plugin-parallel', 'relay-dsh-plugin-skill-creator',
  '@mkaliezz/dsh-repo-map', '@huanlin/dsh-plugin-sleep', '@mkaliezz/dsh-docs', 'dsh-plugin-install',
  'dsh-plugin-manager-companion', 'dsh-web-searxng', '@aiwayds/dsh-cron', '@dsh-plus/shared',
  '@mkaliezz/dsh-error-explainer', '@mkaliezz/dsh-api-client', '@laoyuehanni/dsh-git-worktree',
  '@choate/dsh-plugin-token-stat', '@hqzhao95/dscode', 'dsh-plugins-store', 'dsh-browser-control',
  '@cola1900/dsh-ppt', 'dsh-plugin-diepi', 'dshmarket', 'dsh-plugin-whale-pet', 'dsh-plugin-statusline',
  'dsh-usage-stats', 'dsh-free-search', 'dsh-better-sidebar', 'dsh-artifacts', 'dsh-memory',
];

const out = [];
for (const n of names) {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(n)}`, {
      headers: { 'user-agent': 'dsh-plugin-survey' },
    });
    const j = await res.json();
    out.push([n, j.downloads ?? null, j.error ?? '']);
  } catch (e) {
    out.push([n, null, String(e)]);
  }
}
out.sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1));
for (const [n, d, e] of out) console.log(`${String(d ?? '-').padStart(8)}  ${n}${e ? '  ERR ' + e : ''}`);
