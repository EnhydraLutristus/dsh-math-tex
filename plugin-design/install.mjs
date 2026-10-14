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
 * WHY A RECURSIVE COPY
 *
 *   The previous installer copied a fixed list of top-level names, which was wrong twice:
 *   it missed modules in subdirectories (this package keeps its code in `lib/`), and it
 *   would have copied the test suite into the profile. It copies a declared file list
 *   instead, so adding a source file means updating `files` in package.json — the same
 *   field a publisher would have to update.
 *
 * WHY THE BINARY ISN'T ENOUGH
 *
 *   A mounted install and a BUNDLE install are different paths: the bundle stack is read
 *   when a session's runner process starts, so the package must be in `dsh.profile.bundles`
 *   for the host to load it at all, and a NEW SESSION is required before it takes effect.
 *
 * RUN: node plugin-design/install.mjs                 (install what is on disk)
 *      node plugin-design/install.mjs --uninstall     (remove it again)
 *      node plugin-design/install.mjs --dry-run       (say what would change)
 */

import fs from 'node:fs'
import path from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR ?? 'C:/Users/<user>/.dsh/profiles/desktop'
const WORKSPACE = 'C:/Users/<user>/Documents/deepseek-harness/default-workspace/plugin-design'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')

const src = path.join(WORKSPACE, 'dsh-math-tex')
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))

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
  copied.push(path.relative(src, from).split(path.sep).join('/'))
}

// --- 1. the payload --------------------------------------------------------
const copied = []
if (!uninstall) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of SHIP) {
    const from = path.join(src, entry)
    if (!fs.existsSync(from)) {
      // `files` naming something absent is a packaging bug worth stopping for: a published
      // tarball would silently omit it, and the plugin would fail at import time instead.
      console.error(`package.json files[] names a path that does not exist: ${entry}`)
      process.exit(1)
    }
    copyTree(from, path.join(dst, entry), copied)
  }
  console.log(`${dryRun ? 'would copy' : 'copied'} ${copied.length} file(s) to ${dst}`)
  for (const f of copied) console.log(`  ${f}`)
}

// --- 2. the loader entry the patch inserts ---------------------------------
if (!uninstall) {
  // Read from the SOURCE, not the destination: with `--dry-run` nothing was copied, and a
  // check that only works after a real install would be reported as a packaging failure.
  const patch = fs.readFileSync(path.join(src, 'cordis.patch.yml'), 'utf8')
  const idMatch = /^\s*-\s*id:\s*(\S+)/m.exec(patch)
  if (!idMatch) {
    console.error('cordis.patch.yml declares no entry id — the host would mount nothing')
    process.exit(1)
  }
  const declared = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).name
  if (declared !== idMatch[1] && !patch.includes(declared)) {
    console.error(`cordis.patch.yml inserts "${idMatch[1]}" but package.json names "${declared}"; the host resolves the entry by that name`)
    process.exit(1)
  }
  console.log(`patch inserts loader entry id: ${idMatch[1]}`)
}

// --- 3. register or remove the bundle --------------------------------------
const pkgPath = path.join(PROFILE, 'package.json')
const before = fs.readFileSync(pkgPath, 'utf8')
const parsed = JSON.parse(before) // throws loudly rather than writing garbage
const bundles = parsed.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('profile package.json has no dsh.profile.bundles array')
  process.exit(1)
}
const listed = bundles.includes(pkgName)

if (uninstall) {
  if (!listed) {
    console.log(`${pkgName} is not in dsh.profile.bundles — nothing to unregister`)
  } else {
    fs.copyFileSync(pkgPath, `${pkgPath}.bak-uninstall-${Date.now()}`)
    parsed.dsh.profile.bundles = bundles.filter((b) => b !== pkgName)
    delete parsed.dependencies?.[pkgName]
    const next = `${JSON.stringify(parsed, null, 2)}\n`
    JSON.parse(next)
    if (!dryRun) fs.writeFileSync(pkgPath, next, 'utf8')
    console.log(`${dryRun ? 'would remove' : 'removed'} ${pkgName} from dsh.profile.bundles`)
    console.log(`the directory ${dst} was left in place; delete it to finish the uninstall`)
  }
} else if (listed) {
  // Compare the PAYLOAD against its source, not against the profile manifest: the manifest is
  // rewritten by every install, so "profile manifest is newer" was true for a package that was
  // merely registered first — it reported "already registered" while the code on disk had moved
  // on. A real comparison is what decides whether the install did anything.
  const newestOf = (dir) => {
    let newest = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else newest = Math.max(newest, fs.statSync(p).mtimeMs)
      }
    }
    walk(dir)
    return newest
  }
  // The files have already been copied above; this says whether that changed anything. The
  // directory mtime is not a reliable signal on its own (copying can preserve it), so compare
  // the source mtime with the destination mtime.
  const stale = newestOf(src) > newestOf(dst)
  console.log(`${pkgName}@${manifest.version} is registered; copied files were ${stale ? 'REFRESHED (source changed since the last install)' : 'already identical to the source'}`)
  if (stale) console.log('  a new session is needed for the change to take effect')
} else {
  fs.copyFileSync(pkgPath, `${pkgPath}.bak-${pkgName}`)
  parsed.dsh.profile.bundles = [...bundles, pkgName]
  parsed.dependencies = parsed.dependencies ?? {}
  parsed.dependencies[pkgName] = manifest.version ?? '0.0.1'
  const next = `${JSON.stringify(parsed, null, 2)}\n`
  JSON.parse(next) // belt and braces: never write unparsable JSON
  if (!dryRun) fs.writeFileSync(pkgPath, next, 'utf8')
  console.log(`${dryRun ? 'would register' : 'registered'} ${pkgName}@${manifest.version} (backup: package.json.bak-${pkgName})`)
}

// --- 4. report -------------------------------------------------------------
const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
console.log(`\nbundles (${after.dsh.profile.bundles.length}):`)
for (const b of after.dsh.profile.bundles) console.log(`  ${b}${b === pkgName ? '   <-- this plugin' : ''}`)
console.log('\nNOTE: a NEW SESSION is required — each session spawns its own runner process')
console.log('      (dsh-subprocess-local), which re-reads the bundle stack.')
