const fs = require('fs');
const path = require('path');
const prof = 'C:\\Users\\<user>\\.dsh\\profiles\\desktop';
const yaml = require(path.join(prof, 'node_modules', 'js-yaml'));

const pj = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
console.log('=== package.json ===');
console.log('dependencies:', Object.keys(pj.dependencies).join(', '));
console.log('bundles     :', pj.dsh.profile.bundles.join(', '));

const patchText = fs.readFileSync(path.join(prof, 'cordis.patch.yml'), 'utf8');
const patch = yaml.load(patchText);
console.log('\n=== cordis.patch.yml ===');
console.log('YAML 解析:', Array.isArray(patch) ? `通过，${patch.length} 个条目` : '类型异常');
for (const e of patch) console.log('   -', e.id, '→', e.name);
const petRows = patch.filter((e) => e.id === 'pet' || String(e.name).includes('dsh-pet'));
console.log('残留的 pet 行:', petRows.length === 0 ? '已清除 ✅' : JSON.stringify(petRows));

console.log('\n=== 磁盘实际存在情况 ===');
for (const p of ['dshmarket', 'dsh-better-sidebar', 'dsh-pet', 'dsh-plugin-whale-pet', '@linxin666/dsh-pet', 'dsh-find-plugin']) {
  const d = path.join(prof, 'node_modules', p);
  let info = '不存在';
  if (fs.existsSync(d)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      info = `v${pkg.version}`;
    } catch { info = '存在但 package.json 读不到'; }
  }
  console.log(`   ${p.padEnd(24)} ${info}`);
}

const lock = fs.readFileSync(path.join(prof, 'pnpm-lock.yaml'), 'utf8');
console.log('\n=== 锁文件引用检查 ===');
for (const p of ['dshmarket', 'dsh-better-sidebar', 'dsh-pet', 'dsh-find-plugin', '@linxin666/dsh-pet']) {
  const re = new RegExp(`^\\s{6}${p.replace(/[/@]/g, (m) => '\\' + m)}:\\s*$`, 'm');
  console.log(`   ${p.padEnd(24)} ${re.test(lock) ? '仍在锁文件中 ⚠' : '已移除 ✅'}`);
}
