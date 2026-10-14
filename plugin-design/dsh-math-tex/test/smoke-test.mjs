/**
 * Does the package load the way the host loads it, and does a host-shaped mounting work?
 *
 * This is the test that would have caught the defect in the first draft of this package: a
 * synchronous `require('katex')` that only resolved through a hardcoded absolute path. It
 * failed silently — the oracle went unavailable, `inspect` found nothing wrong, and the
 * guard became a no-op that still logged "listener registered". So the first thing here is
 * that the oracle genuinely loads, without naming a path inside the package.
 *
 * The second half mounts the plugin on a fake Cordis context that records what was called.
 * A real mount needs the whole host, so the context is deliberately thin: it proves both
 * registrations happen and that the options reach them.
 *
 * Run: node test/smoke-test.mjs
 */

import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

/** Import a filesystem path. A Windows path must become a file: URL first. */
const load = (path) => import(pathToFileURL(path).href)

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    failed += 1
    process.stdout.write(`  FAIL ${name}\n       ${err?.message ?? err}\n`)
  }
}

process.stdout.write('package loading\n')

const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const entry = await load(join(pkgRoot, manifest.main))
const { loadOracle, judge, inspectText, repairText } = await load(join(pkgRoot, 'lib', 'tex-repair.js'))

await check('package.json names a main entry', () => {
  assert.equal(manifest.name, 'dsh-math-tex')
  assert.ok(manifest.main, 'main is required for a host-mounted plugin')
  assert.equal(manifest.type, 'module')
})
await check('package.json declares the bundle patch', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
})
await check('entry exports apply()', () => assert.equal(typeof entry.apply, 'function'))
await check('entry re-exports the guard surface', () => {
  for (const name of ['guardStream', 'createBlockState', 'safeCut', 'scanRegions', 'TOKEN', 'BUILD']) {
    assert.ok(name in entry, `missing export ${name}`)
  }
})
await check('entry re-exports the repair surface', () => {
  for (const name of ['repairText', 'inspectText', 'judge', 'rendersRed', 'loadOracle', 'findMathRegions']) {
    assert.ok(name in entry, `missing export ${name}`)
  }
})
await check('entry re-exports the config contract', () => {
  assert.ok(entry.Config && entry.ConfigSchema, 'Config/ConfigSchema missing')
  assert.equal(typeof entry.resolveConfig, 'function')
})
await check('the bundle patch inserts this package id', () => {
  const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: dsh-math-tex/)
  assert.match(patch, /name: 'dsh-math-tex'/)
})

process.stdout.write('\noracle\n')

const status = await loadOracle()
await check('oracle loads without an absolute path being configured', () => {
  assert.equal(status.available, true, `oracle unavailable: ${status.error}`)
})
await check('oracle is the build the client renders with', () => {
  assert.match(status.version, /^0\.16\./, `unexpected katex version ${status.version}`)
})
await check('strict call succeeds on a valid formula', () => {
  const v = judge('E=mc^2=9\\times10^{16}', true)
  assert.equal(v.ok, true, v.message ?? '')
  assert.equal(v.red, false)
})
await check('error-coloured render is detected even when nothing threw', () => {
  const v = judge('\\htmlClass{red}{x}', true)
  assert.equal(v.red, true, 'the diagnostic render should carry the error colour')
})
await check('a healthy document is reported clean', () => {
  const doc = '推导如下：\n\n$$\nS=\\sum_{k=1}^{n}\\frac{1}{k^2}\n$$\n\n所以 n=10 时 S≈1.5498。\n'
  assert.equal(inspectText(doc).flagged.length, 0)
  assert.equal(repairText(doc).repairs.length, 0)
})

process.stdout.write('\nmounting on a host-shaped context\n')

const { apply } = entry
const logLines = []
const sections = []
const listeners = []
const fakeCtx = {
  get(name) {
    if (name === 'logger') return { info: (line) => logLines.push(line) }
    if (name === 'systemPrompt') {
      return {
        section(spec) {
          sections.push(spec)
          return () => {}
        },
      }
    }
    return undefined
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
}

const logDir = mkdtempSync(join(tmpdir(), 'dsh-math-tex-'))
const logFile = join(logDir, 'guard.log')
await apply(fakeCtx, { logFile })

await check('prompt section registered with the expected name', () => {
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'math-output-format')
  assert.ok(sections[0].text.includes('$$'), 'the rules must mention the display delimiter')
})
await check('llm/stream listener registered', () => {
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'llm/stream')
})
await check('the oracle status reached the log', () => {
  assert.ok(logLines.some((l) => /oracle: katex 0\.16/.test(l)), `no oracle line in: ${JSON.stringify(logLines)}`)
})
await check('the file sink recorded the mount', () => {
  const text = readFileSync(logFile, 'utf8')
  assert.match(text, /listener registered/)
  assert.match(text, /oracle: katex/)
})
await check('a guarded stream passes healthy text through byte-identically', async () => {
  const upstream = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '结论：' }
    yield { type: 'text-delta', index: 0, text: 'S≈1.5498。' }
    yield { type: 'block-end', index: 0 }
  })()
  const out = []
  for await (const chunk of entry.guardStream(upstream, {})) {
    if (chunk.type === 'text-delta') out.push(chunk.text)
  }
  assert.equal(out.join(''), '结论：S≈1.5498。')
})
await check('a guarded stream repairs a broken region on the way through', async () => {
  const broken = '看这个 $$x_1_2$$ 公式。'
  const upstream = (async function* () {
    yield { type: 'text-delta', index: 0, text: broken }
  })()
  const out = []
  for await (const chunk of entry.guardStream(upstream, {})) {
    if (chunk.type === 'text-delta') out.push(chunk.text)
  }
  const seen = out.join('')
  assert.notEqual(seen, broken, 'the guard must not pass a broken region through untouched')
  assert.ok(!seen.includes('$$x_1_2$$'), `the broken delimiter pair survived: ${JSON.stringify(seen)}`)
})

process.stdout.write('\nfailure containment\n')

await check('a config that is not an object still mounts', async () => {
  const ctx = { get: () => undefined, on: () => () => {} }
  await apply(ctx, 'not-an-object')
})
await check('an unknown option is reported and ignored, not fatal', async () => {
  const lines = []
  const ctx = {
    get: (n) => (n === 'logger' ? { info: (l) => lines.push(l) } : n === 'systemPrompt' ? { section: () => () => {} } : undefined),
    on: () => () => {},
  }
  await apply(ctx, { nonsense: 1, repair: 'auto' })
  assert.ok(lines.some((l) => /unknown option/.test(l)), JSON.stringify(lines))
})
await check('enabled:false mounts nothing', async () => {
  const ctx = {
    get: (n) => (n === 'logger' ? { info: () => {} } : undefined),
    on: () => {
      throw new Error('must not register when disabled')
    },
  }
  await apply(ctx, { enabled: false })
})
await check('a missing Config service is not fatal', async () => {
  const ctx = { get: () => undefined, on: () => () => {} }
  await apply(ctx)
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
