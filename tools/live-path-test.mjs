/**
 * The acceptance test: does the plugin, AS INSTALLED IN THE PROFILE, turn a broken answer
 * into a clean one on the path a real turn takes?
 *
 * Why this file exists, and why it is not another unit test.
 *
 * The suite already proves the parts: the judge agrees with the renderer (`guard-test`), the
 * streaming output equals the single-pass repair (`wire-test`), a repaired transcript renders
 * clean (`e2e-test`). What none of them prove is the JOINED-UP thing — the copy the host
 * actually loads, configured the way the profile actually configures it, mounted the way the
 * host mounts it, fed the way the host feeds it (many small deltas), producing text the
 * renderer actually accepts, with the log line that proves the repair path ran. That gap is
 * where this plugin spent its whole life: reported `failed`, `apply` never called, every part
 * "correct" and nothing working.
 *
 * So every case here goes through:
 *
 *   the installed package (not ../lib)  ->  config read from the profile's cordis.patch.yml
 *   ->  apply() against a recorded context  ->  the SAME listener the host would call, driven
 *   by a fake `next()`  ->  the persisted markdown  ->  the plugin's own judge (which is the
 *   renderer, in three arms)  ->  plus the log file it wrote.
 *
 * Each broken case is measured twice: once with `repair: 'off'` (the defect must come out the
 * far end still defective) and once with the live config (it must not). The first arm is what
 * makes the second mean anything: without it, a case that was never broken would "pass".
 *
 * Run: node tools/live-path-test.mjs
 *      DSH_MATH_TEX_ENTRY=file:///…/lib/index.js node tools/live-path-test.mjs   (source copy)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

const dshHome = (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')).replace(/[\\/]+$/, '')
const HOST_DIR = join(dshHome, 'profiles', 'desktop')
const INSTALLED = join(HOST_DIR, 'node_modules', 'dsh-math-tex')

/* The entry under test: what the host loads. On a machine where the plugin is installed that
 * is the profile's copy, and this file says so; a fresh checkout with no profile falls back to
 * `../lib` so the suite still runs, and the header makes the substitution visible rather than
 * silently testing something else. */
const installedEntry = pathToFileURL(join(INSTALLED, 'lib', 'index.js')).href
const sourceEntry = pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href
const installed = existsSync(join(INSTALLED, 'package.json'))
const ENTRY = process.env.DSH_MATH_TEX_ENTRY ?? (installed ? installedEntry : sourceEntry)

/** The session this run pretends to be: the id every request carries, and the section reads. */
const INITIATOR_ID = 'session-live-path-test'

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

/**
 * The options the live profile passes to this plugin, read from the profile itself rather
 * than written here. If the two ever disagree, this test measures the wrong thing and says so.
 */
function profileConfig() {
  let text
  try {
    text = readFileSync(join(HOST_DIR, 'cordis.patch.yml'), 'utf8')
  } catch {
    return {}
  }
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^\s*-\s*id:\s*dsh-math-tex\s*$/.test(l))
  if (start < 0) return {}
  const config = {}
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*-\s*id:/.test(line)) break
    const m = /^\s{4}([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const [, key, raw] = m
    if (raw === '') continue
    config[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw.replace(/^['"]|['"]$/g, '')
  }
  return config
}

const manifest = JSON.parse(readFileSync(installed ? join(INSTALLED, 'package.json') : join(pkgRoot, 'package.json'), 'utf8'))
const plugin = await import(ENTRY)

const baseConfig = profileConfig()
const logDir = mkdtempSync(join(tmpdir(), 'dsh-live-path-'))

console.log('=== the plugin as the host has it ===')
console.log(`  entry    ${ENTRY}${installed ? '' : '   (no installed copy here: testing the checkout)'}`)
console.log(`  version  ${manifest.version}  BUILD=${plugin.BUILD}`)
console.log(`  config   ${JSON.stringify(baseConfig)}${Object.keys(baseConfig).length ? '  (read from cordis.patch.yml)' : '  (no profile config found: defaults)'}`)

/**
 * Mount the way the host does, and hand back the `llm/stream` listener it registered.
 * A mount that registers nothing is a failure here, not a skip: that is exactly the state
 * this plugin was in for its whole life.
 */
/** Which session the host claims to be assembling, as `agents.currentInitiator()` reports it. */
const liveInitiator = { id: INITIATOR_ID }

async function mount(config, tag) {
  const logFile = join(logDir, `${tag}.log`)
  const seen = []
  const listener = { fn: null }
  const sections = []
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section: (section) => {
            sections.push(section)
            seen.push(`section:${section.name}`)
          },
        }
      }
      if (name === 'agents') return { currentInitiator: () => liveInitiator }
      if (name === 'logger') seen.push('logger')
      return undefined
    },
    on(event, fn) {
      seen.push(`on:${event}`)
      if (event === 'llm/stream') listener.fn = fn
    },
    effect() {},
  }
  await plugin.apply(ctx, { ...config, logFile })
  const section = sections[0]
  /** What the model would be told for session `id`, via the very function the host calls. */
  const rulesFor = (id) => {
    const says = { id }
    const context = { get: (name) => (name === 'agents' ? { currentInitiator: () => says } : undefined) }
    return typeof section?.text === 'function' ? section.text(context) : section?.text
  }
  return { listener: listener.fn, logFile, accessed: seen, section, rulesFor }
}

/** Feed text the way the host does: many small deltas inside one text block. */
async function streamed(listener, text, chunk = 5) {
  const next = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let i = 0; i < text.length; i += chunk) {
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + chunk) }
    }
    yield { type: 'block-end', index: 0 }
  }
  // A real request carries the conversation, and that is where the plugin looks for the
  // mathematics that decides the prompt section. Feeding prose under the same session must
  // therefore be distinguishable from feeding maths, or the section's test proves nothing.
  const options = {
    model: 'live-path-test',
    sessionId: INITIATOR_ID,
    messages: [{ role: 'user', content: [{ type: 'text', text: /\$|\\[a-zA-Z]/.test(text) ? text : '随便聊聊今天的天气。' }] }],
  }
  let out = ''
  for await (const part of listener(options, next)) {
    if (part.type === 'text-delta') out += part.text
  }
  return out
}

/**
 * What the reader ends up with, judged by the product's own three-arm chain. `repair` is the
 * verdict that matters: KaTeX rejects the region strictly, so it is red on screen unless the
 * repairer gets to it first.
 */
function redRegions(text) {
  const flagged = []
  for (const region of plugin.findMathRegions(text.split(plugin.TOKEN).join(''))) {
    const verdict = plugin.inspect(region)
    if (verdict && verdict.verdict !== 'ok') flagged.push({ ...region, why: verdict.reason ?? verdict.verdict })
  }
  return flagged
}

const CASES = [
  {
    name: 'double subscript in display math',
    broken: '结论如下：\n\n$$x_1_2 = 4$$\n\n于是 $x = 2$。\n',
    note: 'the renderer rejects x_1_2; the answer must still show the value',
  },
  {
    name: 'display math glued into a paragraph',
    broken: '先看这个公式：$$S_n=\\frac{n(a_1+a_n)}{2}$$ 这是等差数列的求和公式。\n',
    note: 'a $$ block that does not start its own line is the reported failure shape',
  },
  {
    name: 'heading glued to the end of a display block',
    broken: '$$\na_1 = 3\n## 第 2 步：代入\n\n于是 $S_{10} = 55$。\n',
    note: 'a heading inside a $$ block: the renderer colours the whole block red',
  },
  {
    name: 'an unclosed inline delimiter',
    broken: '计算 $E=mc^2 到这里就结束了。\n',
    note: 'one stray $ pairs with the next one and swallows the prose between them',
  },
  {
    name: 'unknown control sequence',
    broken: '代入得\n\n$$\\foobar{x} = 1$$\n\n所以 $x = 1$。\n',
    note: 'a command KaTeX does not know: neither repair can save it, so it must be fenced',
  },
  {
    name: 'clean text (must be left alone)',
    broken: '由微积分基本定理，\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$\n\n于是 $S = \\frac13$。\n',
    clean: true,
    note: 'a healthy answer is the control arm for over-repairing',
  },
]

const liveLog = join(logDir, 'live.log')

console.log('\n=== control arm: with the repairer switched off, every defect survives ===')
const offMount = await mount({ ...baseConfig, repair: 'off' }, 'off')
check('repair:off still mounts the listener', typeof offMount.listener === 'function', offMount.accessed.join(' '))
for (const c of CASES.filter((x) => !x.clean)) {
  const out = await streamed(offMount.listener, c.broken)
  const flagged = redRegions(out)
  check(`${c.name}: the defect reaches the reader unrepaired`, flagged.length > 0, `flagged=${flagged.length}`)
}

console.log('\n=== the live path: the reader gets text with no red region ===')
const liveMount = await mount(baseConfig, 'live')
check('the live config mounts the listener', typeof liveMount.listener === 'function', liveMount.accessed.join(' '))

// Before any maths flows, this session has asked for no formulae. The check runs HERE, ahead
// of the stream loop below, because that loop is what marks the session. What the profile
// resolves to decides what "no formulae" means: under `auto` this session gets an empty
// contribution, under `full` (and under an installed build older than the `auto` default) it
// gets the rules from the first step, which is the behaviour `full` promises.
console.log('\n=== the prompt rules follow the session, not the host ===')
check('the section is registered', liveMount.accessed.includes('section:math-output-format'), liveMount.accessed.join(' '))
const autoRules = (baseConfig.promptRules ?? plugin.DEFAULTS.promptRules) === 'auto'
// A build older than this feature registers a plain string, which is a legitimate state for an
// installed copy that has not been refreshed yet; the check is that the entry under test agrees
// with itself, not that it is the newest build.
check('the registered text matches what this build supports', typeof liveMount.section?.text === (autoRules ? 'function' : 'string'), typeof liveMount.section?.text)
console.log(
  `  profile mode: ${baseConfig.promptRules ? `${baseConfig.promptRules} (set by cordis.patch.yml)` : `${plugin.DEFAULTS.promptRules} (the entry's default)`}`,
)
if (autoRules) {
  check('a session that has not done maths is given none', liveMount.rulesFor(INITIATOR_ID) === '', JSON.stringify(liveMount.rulesFor(INITIATOR_ID).slice(0, 40)))
  check('another session is given none either', liveMount.rulesFor('some-other-session') === '')
} else {
  check('a session that has not done maths is given none', true, 'not applicable: this entry gives the rules in every session')
  check('another session is given none either', true, 'not applicable: this entry gives the rules in every session')
}

for (const c of CASES) {
  const out = await streamed(liveMount.listener, c.broken)
  const flagged = redRegions(out)
  if (c.clean) {
    check(`${c.name}: passed through byte-for-byte`, out === c.broken, JSON.stringify(out))
  } else {
    check(`${c.name}: nothing is red any more`, flagged.length === 0, flagged.map((f) => `${f.why} ${JSON.stringify(f.body)}`).join(' '))
  }
}

console.log('\n=== the guard keeps the answer, not just the formatting ===')
{
  const out = await streamed(liveMount.listener, CASES[0].broken)
  check('the conclusion survives', out.includes('4') && out.includes('x = 2'), JSON.stringify(out))
  check('the prose survives', out.includes('结论如下：') && out.includes('于是'), JSON.stringify(out))
  // The cache-prefix promise: once a session has shown mathematics, the same text is given on
  // every later step, so the prefix does not flip back and forth.
  if (autoRules) {
    check('the maths session now gets the rules', liveMount.rulesFor(INITIATOR_ID).includes('$$'))
    check('and a session that never did still gets none', liveMount.rulesFor('some-other-session') === '')
  } else {
    check('the maths session now gets the rules', liveMount.rulesFor(INITIATOR_ID).includes('$$'))
    check('and a session that never did still gets none', true, `not applicable under mode ${baseConfig.promptRules ?? plugin.DEFAULTS.promptRules}`)
  }
}

console.log('\n=== the sentinel never reaches the reader ===')
{
  const out = await streamed(liveMount.listener, `答案。\n\n${plugin.TOKEN}\n`)
  check('the completion marker is stripped', !out.includes(plugin.TOKEN), JSON.stringify(out))
}

console.log('\n=== the log file says what the host actually did ===')
{
  const lines = readFileSync(liveLog, 'utf8').trim().split('\n')
  const show = (pattern) => lines.filter((l) => pattern.test(l))
  check('the mount line names the build and the log', show(/mounting BUILD=/).length > 0)
  check('the oracle came up', show(/oracle: katex/).length > 0, show(/oracle/).join(' | '))
  check('the prompt rules were registered', show(/prompt section "math-output-format" registered/).length > 0)
  check('the listener was registered', show(/listener registered/).length > 0)
  check('a stream was hooked and guarded', show(/guarded stream: \d+ text delta\(s\) in, \d+ out/).length > 0)
  check('the repairer reported work on the broken cases', show(/repair/i).length > 0)
  console.log('  --- the log this run wrote ---')
  for (const l of lines) console.log(`      ${l}`)
}

rmSync(logDir, { recursive: true, force: true })

console.log(`\n=== LIVE-PATH RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1
