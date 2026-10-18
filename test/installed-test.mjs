/**
 * Does the package IN THE PROFILE behave the way the source checkout does?
 *
 * Every other file imports `../lib/…`, which is the code under development. The host import
 * is a different thing: it resolves the package by name from the profile's `node_modules`,
 * and it sees only the files `package.json`'s `files` list actually shipped. A source tree
 * that is green while the installed copy is broken — a module missed by the file list, an
 * import that only resolves relative to the checkout, a stale copy left behind by an
 * earlier install — is exactly the failure this file exists to catch.
 *
 * It is skipped, loudly, when the package is not installed: a missing install is not a test
 * failure, but a silent skip would be.
 *
 * Run: node test/installed-test.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TOKEN } from '../lib/guard.js'
import { loadKatex } from './katex.mjs'

const HOST_DIR = process.env.DSH_HOME
  ? `${process.env.DSH_HOME.replace(/[\\/]+$/, '')}/profiles/desktop`
  : `${(process.env.USERPROFILE ?? process.env.HOME ?? '').replace(/[\\/]+$/, '')}/.dsh/profiles/desktop`
const INSTALLED = join(HOST_DIR, 'node_modules', 'dsh-math-tex')

let pass = 0
let fail = 0
/**
 * Run one named check.
 *
 * It takes a **function** and calls it, which is what every call site below passes. For a
 * while this took a boolean and the call sites passed arrows anyway — a function is truthy, so
 * the whole file could not fail, no matter how stale the installed copy was. A test that
 * cannot fail is worse than no test: it is a claim nobody is checking.
 */
const check = async (name, fn, detail = '') => {
  try {
    await fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`        ${err?.message ?? err}`)
  }
}

if (!existsSync(INSTALLED)) {
  console.log(`SKIPPED — dsh-math-tex is not installed at ${INSTALLED}`)
  console.log('run `node tools/install.mjs` from the package root to install it, then re-run this file')
  process.exit(0)
}

const load = (path) => import(pathToFileURL(path).href)
const manifest = JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8'))
const installed = await load(join(INSTALLED, manifest.main ?? 'lib/index.js'))
const { katex } = await loadKatex()

console.log(`=== the installed copy at ${INSTALLED} ===`)
console.log(`  dsh-math-tex ${manifest.version}, BUILD=${installed.BUILD}, katex ${katex.version}\n`)

console.log('shipped files\n')

await check('the entry declared by package.json is present', () => {
  assert.ok(existsSync(join(INSTALLED, manifest.main)), `missing ${manifest.main}`)
})

await check('every `files` entry shipped', () => {
  const missing = (manifest.files ?? []).filter((f) => !existsSync(join(INSTALLED, f)))
  assert.deepEqual(missing, [], `not copied into the profile: ${missing.join(', ')}`)
})

await check('the licence and manifest came along', () => {
  for (const f of ['LICENSE', 'dsh-plugin.json', 'cordis.patch.yml']) {
    assert.ok(existsSync(join(INSTALLED, f)), `missing ${f}`)
  }
})

await check('the test suite did NOT ship', () => {
  // A published plugin has no business carrying its own test fixtures into a host profile,
  // and the `files` list is what decides that.
  assert.ok(!existsSync(join(INSTALLED, 'test')), 'test/ was copied into the profile')
})

await check('the installed lib/ matches the source lib/', () => {
  const sourceLib = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const installedFiles = readdirSync(join(INSTALLED, 'lib')).sort()
  const sourceFiles = readdirSync(sourceLib).sort()
  assert.deepEqual(installedFiles, sourceFiles, 'the installed copy is stale — re-run install.mjs')
})

await check('the installed lib/ is byte-identical to the source lib/', () => {
  // The file-list check above passes on a copy that is merely the *same set of names*, which
  // is what a stale install looks like: same files, older contents. Measured once during a
  // release: the profile still held the previous version while the source tree was already
  // edited, and the suite stayed green because only names were compared.
  const sourceLib = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const differing = readdirSync(sourceLib).filter((name) => {
    const a = readFileSync(join(sourceLib, name))
    const b = readFileSync(join(INSTALLED, 'lib', name))
    return !a.equals(b)
  })
  assert.deepEqual(differing, [], `installed lib/ differs from source: ${differing.join(', ')} — re-run install.mjs`)
})

console.log('\nthe guards it exports work from the profile\n')

await check('the installed copy loads its own renderer', async () => {
  const status = await installed.loadOracle()
  assert.equal(status.available, true, `oracle unavailable: ${status.error}`)
  assert.match(String(status.version), /^0\.16\./, `unexpected katex ${status.version}`)
})

await check('a broken region is repaired by the installed copy', async () => {
  const broken = '看这个 $$x_1_2$$ 公式。'
  const out = installed.repairText(broken).text
  assert.notEqual(out, broken, 'the installed copy reported nothing to repair')
  assert.ok(!out.includes('$$x_1_2$$'), `still broken: ${JSON.stringify(out)}`)
})

await check('the installed copy renders its own output without a red region', async () => {
  const broken = '看这个 $$x_1_2$$ 公式。'
  const out = installed.repairText(broken).text
  // Judge the whole answer with the installed copy's own scanner, then render every region it
  // finds. The previous version rendered `out` with only the `$` runs at the *ends* of the
  // string stripped, so the `$$` block in the middle reached KaTeX as maths and reported an
  // error colour whether or not the repair had worked. It never mattered, because this file's
  // harness treated each check's function as a truthy assertion — see `check` above.
  const regions = installed.findMathRegions(out)
  assert.ok(regions.length > 0, `no region was found in ${JSON.stringify(out)}`)
  const red = regions.filter((r) => {
    const html = katex.renderToString(r.body, { displayMode: r.kind === 'display', throwOnError: false, strict: 'ignore' })
    return html.includes(installed.ERROR_COLOR)
  })
  assert.deepEqual(red.map((r) => r.body), [], 'a repaired region still renders in the error colour')
  assert.ok(!out.includes('$$x_1_2$$'), `still broken: ${JSON.stringify(out)}`)
})

await check('the installed entry still exports the whole documented surface', () => {
  for (const name of ['apply', 'guardStream', 'createBlockState', 'repairText', 'judge', 'loadOracle', 'Config', 'resolveConfig', 'TOKEN']) {
    assert.ok(name in installed, `missing export ${name}`)
  }
})

await check('the installed Config is one the loader can actually resolve', () => {
  /* Unconditional here, unlike in config-test: the installed copy resolves Schemastery from
   * the profile it sits in, so there is no second state to allow for. See config-test.mjs
   * for why a plain JSON Schema object here is fatal rather than cosmetic. */
  const Config = installed.Config
  assert.equal(typeof Config, 'function', `Config is ${typeof Config}, not a native schema`)
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true, 'missing the Schemastery marker')
  const result = Config['~standard'].validate({})
  assert.ok(!result.issues, `the loader's resolution would fail: ${JSON.stringify(result.issues)}`)
})

await check('the token the guard strips is the one the prompt asks for', () => {
  assert.ok(installed.TOKEN === TOKEN, `installed TOKEN ${installed.TOKEN} differs from source ${TOKEN}`)
})

console.log(`\n=== INSTALLED RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1
