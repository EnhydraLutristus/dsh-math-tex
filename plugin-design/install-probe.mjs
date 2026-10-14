/**
 * Install a probe package into the desktop profile and register its bundle.
 *
 * WHY A SCRIPT: the profile's package.json was damaged once by a PowerShell
 * regex edit — `$1,` landed the comma inside the wrong block and produced
 * invalid JSON that would have broken the profile boot. Editing JSON with a
 * parser, plus a backup, is the only acceptable way to touch this file.
 *
 * WHAT IT DOES
 *   1. copies index.js / package.json / cordis.patch.yml into
 *      <profile>/node_modules/<pkg>
 *   2. re-reads the patch to find the loader entry id it inserts
 *   3. adds the package to `dsh.profile.bundles` and to `dependencies`
 *   4. re-parses the result and prints a diff summary
 *
 * WHY A NEW PACKAGE NAME MATTERS: Node caches `import()` per URL, so editing a
 * module a live process already imported has no effect. A session spawns a
 * fresh runner process (so it does pick up changes), but a *renamed* package is
 * the only way to be certain, and it makes the running build identifiable from
 * the log.
 *
 * RUN: node plugin-design/install-probe.mjs math-guard-probe2
 *      node plugin-design/install-probe.mjs math-guard plugin   (pkg name + source dir)
 */
import fs from 'node:fs'
import path from 'node:path'

const PROFILE = 'C:/Users/<user>/.dsh/profiles/desktop'
const WORKSPACE = 'C:/Users/<user>/Documents/deepseek-harness/default-workspace/plugin-design'

const pkgName = process.argv[2]
if (!pkgName) {
  console.error('usage: node install-probe.mjs <package-name> [source-dir-name]')
  process.exit(1)
}

// The package name and the source directory are usually the same, but a plugin can
// be developed under a working name (e.g. `plugin/`) and installed under its real
// package name (e.g. `math-guard`), which is what the loader resolves.
const src = path.join(WORKSPACE, process.argv[3] ?? pkgName)
const dst = path.join(PROFILE, 'node_modules', pkgName)
if (!fs.existsSync(path.join(src, 'package.json'))) {
  console.error(`no package.json in ${src}`)
  process.exit(1)
}

// --- 1. copy ---------------------------------------------------------------
fs.mkdirSync(dst, { recursive: true })
// Every top-level module is copied, not a fixed list: a plugin split across
// several files silently loses them otherwise, which fails at import time.
const modules = fs.readdirSync(src).filter((f) => f.endsWith('.js') && !f.endsWith('.mjs'))
for (const f of [...modules, 'package.json', 'cordis.patch.yml']) {
  const from = path.join(src, f)
  if (!fs.existsSync(from)) continue
  fs.copyFileSync(from, path.join(dst, f))
  console.log(`copied ${f} -> ${dst}`)
}

// --- 2. the loader entry id the patch inserts ------------------------------
const patch = fs.readFileSync(path.join(dst, 'cordis.patch.yml'), 'utf8')
const idMatch = /^\s*-\s*id:\s*(\S+)/m.exec(patch)
console.log(`patch inserts loader entry id: ${idMatch ? idMatch[1] : '(not found — check the patch!)'}`)

// --- 3. register the bundle ------------------------------------------------
const pkgPath = path.join(PROFILE, 'package.json')
const raw = fs.readFileSync(pkgPath, 'utf8')
const j = JSON.parse(raw) // throws loudly rather than writing garbage

const bundles = j.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('profile package.json has no dsh.profile.bundles array')
  process.exit(1)
}

const already = bundles.includes(pkgName)
if (!already) {
  fs.copyFileSync(pkgPath, `${pkgPath}.bak-${pkgName}`)
  bundles.push(pkgName)
  const version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version ?? '0.0.1'
  j.dependencies = j.dependencies ?? {}
  j.dependencies[pkgName] = version
  const next = `${JSON.stringify(j, null, 2)}\n`
  JSON.parse(next) // belt and braces: never write unparsable JSON
  fs.writeFileSync(pkgPath, next, 'utf8')
  console.log(`registered in dsh.profile.bundles (backup: package.json.bak-${pkgName})`)
} else {
  console.log('already registered — nothing to change')
}

// --- 4. report -------------------------------------------------------------
const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
console.log(`\nbundles (${after.dsh.profile.bundles.length}):`)
for (const b of after.dsh.profile.bundles) console.log(`  ${b}${b === pkgName ? '   <-- this plugin' : ''}`)
console.log(`\nNOTE: a NEW SESSION is required — each session spawns its own runner`)
console.log(`      process (dsh-subprocess-local), which re-reads the bundle stack.`)
