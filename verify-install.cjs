const fs = require('fs');
const path = require('path');
const prof = 'C:\\Users\\<user>\\.dsh\\profiles\\desktop';

const pj = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
console.log('profile bundles:');
for (const b of pj.dsh.profile.bundles) console.log('  - ' + b);
console.log('\ninstalled entries:');
for (const p of ['dshmarket', 'dsh-better-sidebar', 'dsh-find-plugin', 'dsh-plugin-whale-pet']) {
  const d = path.join(prof, 'node_modules', p);
  if (!fs.existsSync(d)) { console.log(`${p}: MISSING`); continue; }
  const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
  const patchRel = pkg.dsh?.bundle?.patch;
  const patchAbs = patchRel ? path.join(d, patchRel) : null;
  const mainAbs = pkg.main ? path.join(d, pkg.main) : null;
  const clientRel = pkg.exports && pkg.exports['./client'];
  const clientAbs = typeof clientRel === 'string' ? path.join(d, clientRel) : null;
  const rows = [
    ['version', pkg.version],
    ['patch', patchAbs ? (fs.existsSync(patchAbs) ? 'ok' : 'MISSING') : 'none'],
    ['main', mainAbs ? (fs.existsSync(mainAbs) ? 'ok' : 'MISSING') : 'none'],
    ['client', clientAbs ? (fs.existsSync(clientAbs) ? 'ok' : 'MISSING') : 'none'],
  ];
  console.log(`\n${p}`);
  for (const [k, v] of rows) console.log(`   ${k.padEnd(8)} ${v}`);
  if (patchAbs && fs.existsSync(patchAbs)) {
    const names = fs.readFileSync(patchAbs, 'utf8').split(/\r?\n/).filter((l) => /^\s*(-\s*)?(id|name):/.test(l)).map((l) => l.trim());
    console.log('   patch entries: ' + names.join(' | '));
  }
}

const lock = fs.readFileSync(path.join(prof, 'pnpm-lock.yaml'), 'utf8');
console.log('\nlockfile importers/deps:');
for (const p of ['dshmarket', 'dsh-better-sidebar', 'dsh-find-plugin']) {
  const re = new RegExp(`^\\s{6}${p}:\\s*$`, 'm');
  console.log(`   ${p}: ${re.test(lock) ? 'in lockfile' : 'NOT in lockfile'}`);
}
console.log('\nnode_modules top-level count: ' + fs.readdirSync(path.join(prof, 'node_modules')).length);
