// Boot smoke test for the installed plugin.
//
// A plugin that throws while loading fails the entire plugin tree at boot, so the
// installed copy is exercised here the way the loader would: import the entry, then
// call apply() with a stub context and check that it registers what it promises.
// Run from the installed directory so `import 'katex'` resolves the way it will live.
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const DIR = 'C:/Users/<user>/.dsh/profiles/desktop/node_modules/math-guard'
const entry = pathToFileURL(`${DIR}/index.js`).href

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== installed plugin boot smoke test ===')
check('package.json exists', existsSync(`${DIR}/package.json`))
check('math-repair.js was installed alongside the entry', existsSync(`${DIR}/math-repair.js`))

const mod = await import(entry)
check('entry imports without throwing', true)
check('exports apply()', typeof mod.apply === 'function')
check('exports a BUILD marker', typeof mod.BUILD === 'string', String(mod.BUILD))
check('exports rewrite helpers for the tests', typeof mod.createBlockState === 'function' && typeof mod.safeCut === 'function')

// --- apply() against a stub context ---------------------------------------
// The plugin reaches services through Cordis's `ctx.get(name)`, so the stub must
// expose it; without it the plugin logs a miss and silently skips the prompt rules.
const listeners = []
const sections = []
const logs = []
const ctx = {
  on(name, fn) { listeners.push({ name, fn }); return () => {} },
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  get(name) {
    if (name !== 'systemPrompt') return undefined
    return { section(s) { sections.push(s); return () => {} } }
  },
}

let threw = null
try {
  mod.apply(ctx)
} catch (err) {
  threw = err
}
check('apply() runs without throwing', threw === null, threw?.message ?? '')

const streamHooks = listeners.filter((l) => l.name === 'llm/stream')
check('registers exactly one llm/stream hook', streamHooks.length === 1, `got ${streamHooks.length}`)
check('registers a system prompt section', sections.length === 1, `got ${sections.length}`)

if (sections.length === 1) {
  const s = sections[0]
  check('the prompt section is named', typeof s.name === 'string' && s.name.length > 0, String(s.name))
  check('the prompt section has a numeric order', typeof s.order === 'number', String(s.order))
  const text = typeof s.text === 'function' ? s.text({}) : s.text
  check('the prompt section carries the maths rules', typeof text === 'string' && text.includes('$$'), String(text).slice(0, 40))
  check('the rules mention the sentinel token', typeof text === 'string' && text.includes(mod.TOKEN))
  console.log(`\n  section name=${s.name} order=${s.order} chars=${String(text).length}`)
}

// --- the hook is a generator factory --------------------------------------
if (streamHooks.length === 1) {
  const fakeChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '普通回答，没有哨兵。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '普通回答，没有哨兵。' } },
  ]
  const inner = (async function* () { for (const c of fakeChunks) yield c })()
  let iter = null
  try {
    iter = streamHooks[0].fn({ model: 'deepseek-flash', sessionId: 'smoke' }, () => inner)
  } catch (err) {
    check('the hook returns a stream without throwing', false, err.message)
  }
  if (iter) {
    check('the hook returns an async iterable', typeof iter[Symbol.asyncIterator] === 'function')
    const seen = []
    for await (const c of iter) seen.push(c)
    check('non-text chunks pass through', seen.length === 3, `saw ${seen.length}`)
    check('plain text is unchanged', seen[1]?.text === '普通回答，没有哨兵。', JSON.stringify(seen[1]?.text))
    check('the final text block still matches its deltas', seen[2]?.block?.text === '普通回答，没有哨兵。')
  }
}

console.log(`\n=== SMOKE RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1
