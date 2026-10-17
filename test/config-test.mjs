/**
 * Do the documented options do what they say?
 *
 * Every other test file measures the DEFAULT build. That is deliberate — the defaults are
 * what a user gets by mounting the plugin and writing nothing — but it leaves the whole
 * `config:` surface unmeasured, and an option that silently does nothing is worse than a
 * missing option: it looks like it worked.
 *
 * So each block here mounts the plugin with one option changed and asserts the observable
 * difference. Two levels are used on purpose:
 *
 *   - `resolveConfig` unit checks, for the validation contract (defaults, unknown keys,
 *     enums, and that the caller's object is not mutated).
 *   - a mount on a host-shaped context, for the effect, because `apply` is where the
 *     options are consumed.
 *
 * Run: node test/config-test.mjs
 */

import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const load = (path) => import(pathToFileURL(path).href)

const { DEFAULTS, ConfigSchema, resolveConfig } = await load(join(pkgRoot, 'lib', 'config.js'))
const { apply, guardStream, TOKEN } = await load(join(pkgRoot, 'lib', 'guard.js'))
const { repairText, inspectText, setOracleOptions, loadOracle } = await load(join(pkgRoot, 'lib', 'tex-repair.js'))

// The oracle has to be up before any config can be judged: with no renderer, "no repairs"
// and "nothing to repair" are indistinguishable, which would make these tests lie.
const oracle = await loadOracle()
if (!oracle.available) {
  console.error(`oracle unavailable, cannot measure repair options: ${oracle.error}`)
  process.exit(1)
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The session the host claims to be assembling; the section's only input in `auto` mode. */
const initiator = { id: 'session-config-test' }

/** The `AssembleContext` the host hands a section's text function: only `get` is ever used. */
const sectionContext = (id = initiator.id) => ({
  get: (name) => (name === 'agents' ? { currentInitiator: () => (id === undefined ? undefined : { id }) } : undefined),
})

/** A host-shaped context: records what the plugin registered, and gives it a log sink. */
function fakeContext(logFile) {
  const sections = []
  const listeners = []
  const ctx = {
    get(name) {
      if (name === 'logger') return { info: () => {}, warn: () => {} }
      if (name === 'agents') return { currentInitiator: () => initiator }
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
  return { ctx, sections, listeners }
}

const logDir = mkdtempSync(join(tmpdir(), 'dsh-math-tex-config-'))
const logFile = join(logDir, 'guard.log')

/** Mount with `options`, then push `text` through the registered hook and return what came out. */
async function run(text, options = {}) {
  const { ctx, sections, listeners } = fakeContext(logFile)
  await apply(ctx, { logFile, ...options })
  const hook = listeners.find((l) => l.event === 'llm/stream')
  if (!hook) return { out: text, sections, mounted: false }
  const upstream = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0 }
  })()
  const chunks = []
  // `llm/stream` is a waterfall: the listener is handed the model call's own stream factory
  // as `next`. Calling it is what a real host does; passing the fake upstream through it
  // keeps the guard under test rather than a stub.
  for await (const chunk of hook.handler({}, () => upstream)) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return { out: chunks.join(''), sections, mounted: true }
}

const BROKEN = '看这个 $$x_1_2$$ 公式。'
const BROKEN_REPAIRED = repairText(BROKEN).text
if (BROKEN === BROKEN_REPAIRED) {
  console.error('fixture is not broken, the repair options cannot be measured')
  process.exit(1)
}

console.log('config contract\n')

check('DEFAULTS has exactly the documented keys', () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [
    'enabled',
    'katexPath',
    'logFile',
    'macros',
    'maxHold',
    'promptRules',
    'repair',
    'tailBuffer',
  ])
})

check('an empty config resolves to the defaults', () => {
  const { config, errors } = resolveConfig({})
  assert.deepEqual(errors, [])
  assert.deepEqual(config, { ...DEFAULTS, logFile: config.logFile })
})

check('undefined and null mean "not set"', () => {
  const { config, errors } = resolveConfig({ enabled: undefined, repair: null, macros: undefined })
  assert.deepEqual(errors, [])
  assert.equal(config.enabled, DEFAULTS.enabled)
  assert.equal(config.repair, DEFAULTS.repair)
})

check('a partial config keeps the other defaults', () => {
  const { config, errors } = resolveConfig({ repair: 'off', tailBuffer: 40 })
  assert.deepEqual(errors, [])
  assert.equal(config.repair, 'off')
  assert.equal(config.tailBuffer, 40)
  assert.equal(config.maxHold, DEFAULTS.maxHold)
  assert.equal(config.promptRules, DEFAULTS.promptRules)
})

check('the caller keeps every key, including unknown ones', () => {
  const input = { repair: 'off' }
  resolveConfig(input)
  assert.deepEqual(Object.keys(input), ['repair'])
})

check('the caller\'s macros object is not handed back by reference', () => {
  const macros = { '\\RR': '\\mathbb{R}' }
  const { config } = resolveConfig({ macros })
  assert.deepEqual(config.macros, macros)
  assert.notEqual(config.macros, macros)
})

check('an unknown key is an error, not a silent no-op', () => {
  const { errors } = resolveConfig({ tailBuf: 20 })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /tailBuf/)
})

check('an unknown key does not destroy the valid ones', () => {
  const { config, errors } = resolveConfig({ tailBuf: 20, repair: 'off' })
  assert.equal(errors.length, 1)
  assert.equal(config.repair, 'off')
})

check('a bad enum value is reported', () => {
  for (const bad of [{ repair: 'sometimes' }, { promptRules: 'loud' }, { enabled: 'yes' }]) {
    const { errors } = resolveConfig(bad)
    assert.equal(errors.length, 1, `${JSON.stringify(bad)} was accepted`)
  }
})

check('a non-numeric bound is reported', () => {
  for (const bad of [{ tailBuffer: 'big' }, { maxHold: null }, { macros: [] }]) {
    const { errors } = resolveConfig(bad)
    assert.equal(errors.length, 1, `${JSON.stringify(bad)} was accepted`)
  }
})

check('ConfigSchema is closed so a typo cannot hide', () => {
  assert.equal(ConfigSchema.additionalProperties, false)
  assert.ok(ConfigSchema.properties.repair, 'repair must be described')
})

console.log('\nprompt rules\n')

{
  const full = await run('正文。', {})
  check('promptRules=full registers the long section', () => {
    assert.equal(full.sections.length, 1)
    assert.equal(full.sections[0].name, 'math-output-format')
    const text = full.sections[0].text
    assert.ok(typeof text === 'function' ? text(sectionContext()) : text.includes('结论数值'), 'the full rules mention the conclusion rule')
    assert.ok(typeof text === 'function' ? text(sectionContext()).includes(TOKEN) : text.includes(TOKEN), 'the full rules carry the receipt marker')
  })
  // 1.2.8: a formula that is the SUBJECT of the answer must be quoted, or the guard repairs the
  // example itself. Measured on session-ae727c2a: the model was asked to emit HTML, wrote
  // `<b>$x_1_2$</b>`, and the guard turned the deliberately-wrong sample into `$x_{1_2}$`, so
  // items ① and ② ended up identical while claiming opposite verdicts.
  const fullText = typeof full.sections[0].text === 'function' ? full.sections[0].text(sectionContext()) : full.sections[0].text
  check('the full rules ask for a formula being discussed to be quoted', () => {
    assert.ok(fullText.includes('故意写错的例子'), 'the quoting rule is present')
    assert.ok(fullText.includes('反引号'), 'and it names the mechanism: backticks')
  })
}

{
  // The default is `auto`, so this block is what a profile with no `promptRules` gets.
  const host = fakeContext(logFile)
  await apply(host.ctx, { logFile, promptRules: 'auto' })
  check('promptRules=auto (the default) registers the section', () => {
    assert.equal(host.sections.length, 1)
    assert.equal(typeof host.sections[0].text, 'function', 'auto decides per session, so the text must be a function')
  })
  const say = (id) => (typeof host.sections[0].text === 'function' ? host.sections[0].text(sectionContext(id)) : host.sections[0].text)
  check('promptRules=auto gives a maths-free session nothing', () => {
    assert.equal(say(initiator.id), '')
    assert.equal(say('some-other-session'), '')
    assert.equal(say(undefined), '', 'no session to identify means no rules, and the guard logs that')
  })

  // Now prove the marking end to end: a request carrying maths marks the session, and the very
  // next assembly of that session is given the rules.
  const hook = host.listeners.find((l) => l.event === 'llm/stream')
  const upstream = (async function* () {
    yield { type: 'text-delta', index: 0, text: '通解是 $$u=f(x-at)$$。' }
  })()
  const request = {
    sessionId: initiator.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '波动方程的通解是什么？' }] }],
  }
  let seen = ''
  for await (const chunk of hook.handler(request, () => upstream)) {
    if (chunk.type === 'text-delta') seen += chunk.text
  }
  check('promptRules=auto marks the session that carried maths', () => {
    assert.ok(seen.includes('u=f(x-at)'), JSON.stringify(seen))
    assert.ok(say(initiator.id).includes(TOKEN), 'the marked session must be given the full rules')
    assert.equal(say('some-other-session'), '', 'a different session must not inherit the mark')
  })
}

{
  const minimal = await run('正文。', { promptRules: 'minimal' })
  check('promptRules=minimal registers a shorter section', () => {
    assert.equal(minimal.sections.length, 1)
    assert.ok(minimal.sections[0].text.length < 400, `minimal section is ${minimal.sections[0].text.length} chars`)
    assert.ok(!minimal.sections[0].text.includes('结论数值'), 'minimal must not carry the readability rules')
  })
  check('minimal leaves the quoting rule out', () => {
    assert.ok(!minimal.sections[0].text.includes('故意写错的例子'), 'the quoting rule belongs to the full set only')
  })
}

{
  const off = await run('正文。', { promptRules: 'off' })
  check('promptRules=off registers no section', () => {
    assert.equal(off.sections.length, 0)
  })
  check('promptRules=off still guards the stream', () => {
    assert.equal(off.out, BROKEN_REPAIRED)
  })
}

console.log('\nrepair modes\n')

{
  const auto = await run(BROKEN, {})
  check('repair=auto rewrites a region that would render red', () => {
    assert.equal(auto.out, BROKEN_REPAIRED)
    assert.ok(!auto.out.includes('$$x_1_2$$'), 'the broken delimiters are gone')
  })
}

{
  const checkOnly = await run(BROKEN, { repair: 'check-only' })
  check('repair=check-only leaves the text alone', () => {
    assert.equal(checkOnly.out, BROKEN, `check-only changed the text to ${JSON.stringify(checkOnly.out)}`)
  })
  check('repair=check-only still records what it found', () => {
    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /check-only/)
  })
}

{
  const off = await run(BROKEN, { repair: 'off' })
  check('repair=off is a pure pass-through', () => {
    assert.equal(off.out, BROKEN)
  })
}

{
  const enabledOff = await run(BROKEN, { enabled: false })
  check('enabled=false registers nothing at all', () => {
    assert.equal(enabledOff.sections.length, 0)
    assert.equal(enabledOff.mounted, false)
    assert.equal(enabledOff.out, BROKEN)
  })
}

console.log('\nstream bounds\n')

{
  // `tailBuffer` is the smallest suffix the guard refuses to release, because a completion
  // marker can arrive one character at a time. Observation: release text, then look at how
  // much of it the FIRST push produced, before `finish()` flushes the rest.
  const text = '一段足够长的纯文本，不含任何公式，用来观察尾部缓冲。'
  const state = (await load(join(pkgRoot, 'lib', 'guard.js'))).createBlockState({ tailBuffer: 120 })
  const first = state.push(text)
  check('tailBuffer withholds the configured suffix', () => {
    assert.ok(first.length < text.length, `everything was released immediately (${first.length} chars)`)
    assert.ok(!first.endsWith('。'), 'the final punctuation should still be held')
  })
  const flushed = first + state.finish()
  check('finish() releases what the tail buffer held', () => {
    assert.equal(flushed, text)
  })
}

{
  // `maxHold` bounds the wait on one incomplete region. With a tiny bound the guard must
  // give up and release the text unrepaired rather than stall; with a large one it holds.
  //
  // KaTeX warns to the console for every CJK character it sees inside maths, and this
  // fixture is intentionally full of unclosed maths, so the warnings are silenced here:
  // they would bury the result without changing it.
  const warn = console.warn
  console.warn = () => {}
  try {
    const partial = '开口没关的公式 $$\\frac{1}{2} 后面跟着很长的文字'.repeat(4)
    const tight = (await load(join(pkgRoot, 'lib', 'guard.js'))).createBlockState({ maxHold: 20 })
    const tightOut = tight.push(partial) + tight.finish()
    check('a region past maxHold is released rather than held forever', () => {
      assert.ok(tightOut.includes('\\frac{1}{2}'), 'the source text must survive either way')
    })
  } finally {
    console.warn = warn
  }
}

console.log('\nmacros\n')

{
  // A macro the renderer does not know is exactly the red-render class, so the option is
  // only real if defining it turns a rejected region into a rendering one.
  setOracleOptions({ macros: {} })
  const withoutMacro = inspectText('$$\\RR$$').flagged.length
  setOracleOptions({ macros: { '\\RR': '\\mathbb{R}' } })
  const withMacro = inspectText('$$\\RR$$').flagged.length
  check('config macros reach the oracle', () => {
    assert.ok(withoutMacro > 0, 'without the macro the region should be flagged')
    assert.equal(withMacro, 0, 'with the macro the same region should render')
  })

  const mounted = await run('$$\\RR$$', { macros: { '\\RR': '\\mathbb{R}' } })
  check('a config macro changes the mounted behaviour', () => {
    assert.equal(mounted.out, '$$\\RR$$', `the macro made the text render, so it must pass through: ${JSON.stringify(mounted.out)}`)
  })
  setOracleOptions({ macros: {} })
}

console.log('\nlog file\n')

{
  const custom = join(logDir, 'custom.log')
  await run('正文。', { logFile: custom })
  check('logFile redirects the log', () => {
    const text = readFileSync(custom, 'utf8')
    assert.match(text, /listener registered/)
    assert.match(text, /oracle: katex/)
  })
}

/* The export the LOADER reads, not the plugin: this is the one that decides whether the
 * fiber starts at all.
 *
 * cordis resolves an entry's config as `runtime.Config['~standard'].validate(config)`
 * (cordis `lib/index.js:956-962`). A plain JSON-Schema object has no `~standard`, so that
 * line throws `TypeError: Cannot read properties of undefined (reading 'validate')` inside
 * the fiber's `_reload()`, which catches it and marks the fiber FAILED. The plugin then
 * appears in the inventory as "异常/failed" and its `apply` is never called — no log, no
 * prompt section, no listener. Every assertion below is one measured piece of that failure.
 */
{
  const { Config } = await load(join(pkgRoot, 'lib', 'config.js'))
  if (Config === undefined) {
    /* Legitimate on a machine with no Schemastery to build it from (see `loadSchemastery`);
     * the installed copy is checked unconditionally in `installed-test.mjs`. */
    console.log('  skip  Config export (no Schemastery resolvable from this checkout)')
  } else {
    check('Config is a native Schemastery schema', () => {
      assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true)
      assert.equal(typeof Reflect.get(Config, 'type'), 'string')
      assert.equal(typeof Reflect.get(Config, 'meta'), 'object')
    })
    check('the loader can resolve a config against it', () => {
      const result = Config['~standard'].validate({ logFile: 'x.log' })
      assert.ok(!result.issues, `unexpected issues: ${JSON.stringify(result.issues)}`)
      assert.equal(result.value.logFile, 'x.log')
      assert.equal(result.value.tailBuffer, DEFAULTS.tailBuffer)
    })
    check('the loader schema defaults still match DEFAULTS', () => {
      const filled = Config['~standard'].validate({}).value
      for (const [key, value] of Object.entries(DEFAULTS)) {
        assert.deepEqual(filled[key], value, `${key} default drifted from DEFAULTS`)
      }
    })
  }
}

console.log(`\n=== CONFIG RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1
void guardStream
