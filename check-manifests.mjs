// Inspect dsh-related manifest fields (dsh.bundle, engines, peer deps) for the three picks + installed example.
const picks = ['dshmarket', 'dsh-better-sidebar', 'dsh-find-plugin', 'dsh-plugin-whale-pet'];
async function j(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-install-check' } });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(t);
}
for (const p of picks) {
  try {
    const meta = await j(`https://registry.npmjs.org/${p.replace('/', '%2f')}`);
    const latest = meta['dist-tags']?.latest;
    const v = meta.versions?.[latest] ?? {};
    console.log(`\n### ${p}@${latest}  published ${meta.time?.[latest]}`);
    console.log('  engines:', JSON.stringify(v.engines ?? {}));
    console.log('  dsh:', JSON.stringify(v.dsh ?? null));
    console.log('  peerDependencies:', JSON.stringify(v.peerDependencies ?? {}));
    console.log('  dependencies:', JSON.stringify(v.dependencies ?? {}));
    console.log('  scripts:', JSON.stringify(v.scripts ?? {}));
    console.log('  files:', JSON.stringify(v.files ?? null));
    console.log('  dist.tarball:', v.dist?.tarball);
    console.log('  versions(last 5):', Object.keys(meta.versions ?? {}).slice(-5).join(', '));
  } catch (e) {
    console.log(`\n### ${p}: FAILED ${e}`);
  }
}
