const fs = require('fs');
const path = require('path');
const prof = 'C:\\Users\\<user>\\.dsh\\profiles\\desktop';
const nm = path.join(prof, 'node_modules');

function size(p) {
  let total = 0;
  let files = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; files++; } catch {} }
    }
  };
  walk(p);
  return { mb: total / 1048576, files };
}

// ---------- 1. 你直接声明的（顶层） ----------
const pj = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
console.log('=== ① 你「直接声明」的依赖（profile 的 package.json -> dependencies）===');
for (const [n, v] of Object.entries(pj.dependencies)) console.log(`   ${n.padEnd(24)} ${v}`);
console.log('   这些是你要求装的；其余全部是它们自己拖进来的。');

// ---------- 2. 传递依赖规模 ----------
const dirs = fs.readdirSync(nm).filter((d) => !d.startsWith('.'));
const flat = [];
for (const d of dirs) {
  if (d.startsWith('@')) for (const s of fs.readdirSync(path.join(nm, d))) flat.push(`${d}/${s}`);
  else flat.push(d);
}
const sizes = flat.map((d) => ({ d, ...size(path.join(nm, d)) }));
const totalMb = sizes.reduce((a, b) => a + b.mb, 0);
const totalFiles = sizes.reduce((a, b) => a + b.files, 0);
console.log(`\n=== ② 去重后磁盘上真实存在的包 ===`);
console.log(`   ${flat.length} 个包 / ${totalMb.toFixed(1)} MB / ${totalFiles} 个文件`);
const hoisted = sizes.filter((s) => s.d === 'dshmarket' || s.d === 'dsh-better-sidebar' || s.d === 'dsh-find-plugin' || s.d === 'dsh-plugin-whale-pet');
console.log(`   其中你原本就有 1 个插件，本次新增 3 个插件 + 它们的依赖`);

// ---------- 3. 每个插件的 dependencies / peerDependencies / devDependencies ----------
console.log('\n=== ③ 三个插件各自声明了什么 ===');
for (const p of ['dshmarket', 'dsh-better-sidebar', 'dsh-find-plugin']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(nm, p, 'package.json'), 'utf8'));
  const deps = Object.entries(pkg.dependencies || {});
  const peers = Object.entries(pkg.peerDependencies || {});
  const dev = Object.entries(pkg.devDependencies || {});
  console.log(`\n   ${p}@${pkg.version}`);
  console.log(`     dependencies (${deps.length}) —— 它自己 import 的库，必须随它一起装：`);
  console.log('       ' + (deps.map(([n, v]) => `${n}@${v}`).join(', ') || '（无）'));
  console.log(`     peerDependencies (${peers.length}) —— 它假定「宿主已经提供」，因此自己不装：`);
  console.log('       ' + (peers.map(([n, v]) => `${n}@${v}`).join(', ') || '（无）'));
  console.log(`     devDependencies (${dev.length}) —— 作者开发/构建才用，不会进你机器：`);
  console.log(`       ${dev.slice(0, 5).map(([n]) => n).join(', ')}${dev.length > 5 ? ', …' : ''}`);
}

// ---------- 4. 最占地方的包 ----------
console.log('\n=== ④ 本次体积大头（Top 12） ===');
sizes.sort((a, b) => b.mb - a.mb);
for (const s of sizes.slice(0, 12)) console.log(`   ${s.d.padEnd(28)} ${s.mb.toFixed(1).padStart(7)} MB   ${s.files} 文件`);

// ---------- 5. 锁文件里 4 个插件的依赖条目数 ----------
const lock = fs.readFileSync(path.join(prof, 'pnpm-lock.yaml'), 'utf8');
console.log('\n=== ⑤ 锁文件规模 ===');
console.log(`   pnpm-lock.yaml ${lock.split(/\r?\n/).length} 行 —— 记录每个包的确切版本 + 校验和，保证下次装出完全一样的树`);
