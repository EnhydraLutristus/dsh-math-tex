// Does the INSTALLED guard leave any red region behind, on real text?
//
// This runs against `node_modules/math-guard`, the copy the host actually loads, not the
// workspace source. The assertion that matters is at the end: render every region the
// guard emitted, with the product's own chain, and require that none of them comes back
// with the error colour. Anything red that survives is something the reader will see.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROFILE = 'C:/Users/<user>/.dsh/profiles/desktop'
const require = createRequire(`${PROFILE}/package.json`)
const katex = require('katex')
const DIR = `${PROFILE}/node_modules/math-guard`
const { findMathRegions, repairText, rendersRed } = await import(pathToFileURL(`${DIR}/math-repair.js`).href)
const guard = await import(pathToFileURL(`${DIR}/index.js`).href)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const renders = (tex, displayMode) => {
  let html = null
  try {
    html = katex.renderToString(tex, { displayMode, throwOnError: true })
  } catch {
    try {
      html = katex.renderToString(tex, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      return { red: false }
    }
  }
  return { red: rendersRed(html) }
}

const countRed = (text) => findMathRegions(text).filter((r) => renders(r.body, r.kind === 'display').red).length

console.log('=== installed guard, red-render check ===')
console.log(`  BUILD=${guard.BUILD}, katex ${katex.version}`)

// --- a document with every class of red-producing maths --------------------
const parts = [
  '# 推导过程',
  '',
  '正常的一段：$u=\\frac12[\\varphi(0)+\\varphi(2)]$ 没问题。',
  '',
  '段中行间公式：$$u=\\tfrac12[\\varphi(1)+\\varphi(1)]=\\varphi(1)=e^{-1}=0.367879$$',
  '',
  '未知命令：$\\foobar{x}=y$ 这里应该是红的。',
  '',
  '被禁用的扩展命令：$\\htmlClass{red}{z}$ 严格模式下不报错但仍然是红的。',
  '',
  '真的坏了：$\\frac{1}{2$ 少一个括号。',
  '',
  '又一个坏的：$x_1_2$ 双下标。',
  '',
  '结尾：$\\begin{cases} a & x\\ge t \\\\ b & x<t \\end{cases}$ 环境本身没问题。',
  '',
  guard.TOKEN,
].join('\n')

const beforeRed = countRed(parts)
check('the input really does contain red regions', beforeRed > 0, `${beforeRed}`)

// Stream it in one-character deltas — the worst case for a streaming guard.
const state = guard.createBlockState()
let streamed = ''
for (let i = 0; i < parts.length; i += 1) streamed += state.push(parts[i])
streamed += state.finish()

const afterRed = countRed(streamed)
check('one-char streaming: the sentinel is gone', !streamed.includes(guard.TOKEN))
check('one-char streaming: no region renders red', afterRed === 0, `${afterRed} red region(s) left`)
check('one-char streaming: content survived', streamed.includes('推导过程') && streamed.includes('0.367879'), 'text lost')

// --- every chunking must agree, and all must be red-free -------------------
const run = (size) => {
  const s = guard.createBlockState()
  let out = ''
  for (let i = 0; i < parts.length; i += size) out += s.push(parts.slice(i, i + size))
  return out + s.finish()
}
const reference = run(100000)
const sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597]
const differing = sizes.filter((s) => run(s) !== reference)
check('every chunking yields identical output', differing.length === 0, `differ at ${differing.join(',')}`)
const redPerChunking = sizes.map((s) => ({ s, red: countRed(run(s)) })).filter((x) => x.red > 0)
check('no chunking leaves a red region', redPerChunking.length === 0, JSON.stringify(redPerChunking.slice(0, 4)))
check('the repaired output has no red either', countRed(reference) === 0, `${countRed(reference)}`)

// --- the repair is visible, not silent -------------------------------------
const repaired = repairText(parts)
const reasons = [...new Set(repaired.repairs.map((r) => r.reason))]
check('the guard classified the damage', repaired.repairs.length >= 4, `${repaired.repairs.length} repair(s)`)
console.log(`  reasons seen: ${reasons.join(', ')}`)
for (const r of repaired.repairs) console.log(`    [${r.reason}] ${(r.detail ?? '').slice(0, 62)}`)

// The repaired variants must be readable: the command name is shown, not dropped.
check('an unknown command becomes visible text', reference.includes('foobar') && !/\\foobar/.test(reference), 'token lost')
check('unrecoverable source is still readable in a fence', reference.includes('```'), 'no fence emitted')

console.log(`\n=== INSTALLED RED CHECK: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1
