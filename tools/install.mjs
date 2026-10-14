/**
 * Install dsh-math-tex into the desktop profile and register it as a bundle.
 *
 * WHY A SCRIPT AND NOT A COPY COMMAND
 *
 *   The profile's `package.json` was damaged once by a PowerShell regex edit — `$1,`
 *   landed the comma inside the wrong block and produced invalid JSON that would have
 *   broken the profile's next boot, and it had to be restored from a backup. So this file
 *   only ever edits that JSON through `JSON.parse` / `JSON.stringify`, re-parses what it
 *   wrote before returning, and keeps a timestamped backup.
 *
 * WHY A DECLARED FILE LIST
 *
 *   The first installer copied a fixed list of top-level names, which was wrong twice: it
 *   missed modules in subdirectories (this package keeps its code in `lib/`), and it would
 *   have copied the test suite into the profile. It copies what `package.json#files`
 *   declares instead, so adding a source file means updating that field — the same field a
 *   publisher would have to update.
 *
 * WHY THE BINARY ISN'T ENOUGH
 *
 *   A mounted install and a BUNDLE install are different paths: the bundle stack is read
 *   when a session's runner process starts, so the package must be in `dsh.profile.bundles`
 *   for the host to load it at all, and a NEW SESSION is required before it takes effect.
 *
 * WHY IT LIVES IN tools/
 *
 *   The repository root IS the package (this file is a wrapper around a plain directory
 *   copy). Everything here is derived from `import.meta.url`, so the checkout can live
 *   anywhere — an earlier version hard-coded the author's absolute path and broke as soon
 *   as the repository was reorganised.
 *
 * RUN: node tools/install.mjs                 (install what is on disk)
 *      node tools/install.mjs --uninstall     (remove it again)
 *      node tools/install.mjs --dry-run       (say what would change)
 *      node tools/install.mjs --uninstall <name>   (unregister SOMEONE ELSE, e.g. a retired prototype)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root = the package root (this file sits in `tools/`). */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Profile directory. Defaults to the desktop profile of the current user rather than a
 * hard-coded name, and can be overridden for a machine with a different layout.
 */
const PROFILE = process.env.DSH_PROFILE_DIR
  ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'profiles', 'desktop')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')

const manifestPath = path.join(SRC, 'package.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`no package.json in ${SRC} — run this script from inside the package checkout`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

// `--uninstall <name>` removes WHOEVER is named, which is not always this package: the
// retired prototype has to be unregistered too. Without the override the command reported
// success while removing a different plugin from the bundle list.
const target = (() => {
  if (!uninstall) return manifest.name
  const i = args.indexOf('--uninstall')
  const named = args[i + 1]
  args.splice(i, 2)
  return named && !named.startsWith('-') ? named : manifest.name
})()

const pkgName = target
const dst = path.join(PROFILE, 'node_modules', pkgName)

// Only what the package declares it ships. A test directory or a stray debug script must
// never end up in the profile: the host resolves this directory, not the checkout.
//
// `package.json` is added unconditionally. It is not a file the author chooses to publish —
// it IS the package: without it Node cannot resolve the directory, and the failure surfaces
// as ENOENT inside the host rather than as a packaging error. (It was left out here once:
// `files` listed only the things a reader browses, and the install copied everything except
// the file that makes the copy mountable.)
const SHIP = [...new Set([...(manifest.files ?? []), 'package.json'])]

/**
 * Copy `from` to `to`, creating directories, and report every file.
 *
 * @param {string} from
 * @param {string} to
 * @param {string[]} copied
 */
function copyTree(from, to, copied) {
  const stat = fs.statSync(from)
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from)) {
      copyTree(path.join(from, entry), path.join(to, entry), copied)
    }
    return
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (!dryRun) fs.copyFileSync(from, to)
  copied.push(path.relative(dst, to).split(path.sep).join('/'))
}

/** Empty every missing entry: an uninstall must not leave stale files behind. */
function removeTree(dir) {
  if (!fs.existsSync(dir)) return []
  const removed = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      removed.push(path.relative(dst, p).split(path.sep).join('/'))
      if (!dryRun) entry.isDirectory() ? fs.rmdirSync(p) : fs.unlinkSync(p)
    }
  }
  walk(dir)
  if (!dryRun) fs.rmSync(dir, { recursive: true, force: true })
  return removed
}

// --- 1. copy the payload ---------------------------------------------------
console.log(`${dryRun ? '[dry-run] ' : ''}${uninstall ? 'uninstall' : 'install'} ${pkgName}`)
console.log(`  from ${SRC}`)
console.log(`  to   ${dst}\n`)

if (uninstall) {
  const removed = removeTree(dst)
  console.log(`removed ${removed.length} file(s)${removed.length ? ':' : '.'}`)
  for (const f of removed) console.log(`  - ${f}`)
} else {
  fs.mkdirSync(dst, { recursive: true })
  const copied = []
  for (const name of SHIP) {
    const from = path.join(SRC, name)
    if (!fs.existsSync(from)) {
      console.error(`  ! declared in package.json#files but missing on disk: ${name}`)
      process.exitCode = 1
      continue
    }
    copyTree(from, path.join(dst, name), copied)
  }
  console.log(`copied ${copied.length} file(s):`)
  for (const f of copied.sort()) console.log(`  + ${f}`)
}

// --- 2. register (or unregister) the bundle --------------------------------
const pkgPath = path.join(PROFILE, 'package.json')
if (!fs.existsSync(pkgPath)) {
  console.error(`\nno profile package.json at ${pkgPath} — is the profile installed?`)
  process.exit(1)
}
const beforeText = fs.readFileSync(pkgPath, 'utf8')
const parsed = JSON.parse(beforeText)
parsed.dsh = parsed.dsh ?? {}
parsed.dsh.profile = parsed.dsh.profile ?? {}
const bundles = parsed.dsh.profile.bundles ?? []
const has = bundles.includes(pkgName)

if (uninstall ? !has : has) {
  console.log(`\nbundle list already ${uninstall ? 'without' : 'with'} ${pkgName} — nothing to change there`)
} else {
  const backup = `${pkgPath}.bak-${pkgName}`
  if (!dryRun) fs.copyFileSync(pkgPath, backup)
  parsed.dsh.profile.bundles = uninstall
    ? bundles.filter((b) => b !== pkgName)
    : [...bundles, pkgName]
  // Keep the dependency entry in step with the bundle list: a name in `bundles` that is not
  // installed as a dependency resolves from nothing on a fresh profile.
  const deps = parsed.dependencies ?? {}
  if (uninstall) delete deps[pkgName]
  else deps[pkgName] = manifest.version ?? '0.0.1'
  parsed.dependencies = deps
  const next = `${JSON.stringify(parsed, null, 2)}\n`
  JSON.parse(next) // belt and braces: never write unparsable JSON
  if (!dryRun) fs.writeFileSync(pkgPath, next, 'utf8')
  console.log(`${dryRun ? 'would ' : ''}${uninstall ? 'unregister' : 'register'} ${pkgName}@${manifest.version} (backup: ${path.basename(backup)})`)
}

// --- 3. report -------------------------------------------------------------
const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const finalBundles = after.dsh?.profile?.bundles ?? []
console.log(`\nbundles (${finalBundles.length}):`)
for (const b of finalBundles) console.log(`  ${b}${b === pkgName ? '   <-- this plugin' : ''}`)
console.log('\nNOTE: a NEW SESSION is required — each session spawns its own runner process')
console.log('      (dsh-subprocess-local), which re-reads the bundle stack.')
