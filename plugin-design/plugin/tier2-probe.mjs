// Measure how the pinned KaTeX reports an UNDEFINED CONTROL SEQUENCE.
//
// Purpose: tier 2 of the product's chain (`strict:'ignore'`, `throwOnError:false`)
// renders an unknown command as if nothing were wrong. The fix has to know (a) the
// exact error text and whether it names the command, and (b) whether making the
// command literal turns a strict failure into a strict pass. This measures both
// instead of assuming either.
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/<user>/.dsh/profiles/desktop/package.json')
const katex = require('katex')

const cases = [
  ['unknown command', '\\foobar{x}'],
  ['unknown command, no args', 'x = \\notacommand'],
  ['two unknown commands', '\\foo{1} + \\bar{2}'],
  ['unknown command inside cases', '\\begin{cases} \\bad & x \\ge t \\\\ b & x < t \\end{cases}'],
  ['CJK in \\text{}', '\\text{右行波}'],
  ['legal control sequence', '\\frac{1}{2}'],
  ['deep nesting, legal', '\\underbrace{\\underbrace{a}_{1}}_{2}'],
  ['unclosed brace', '\\frac{1}{2'],
  ['double subscript', 'x_1_2'],
]

const strict = (tex, displayMode = true) => {
  try {
    katex.renderToString(tex, { displayMode, throwOnError: true })
    return { tier: 1, message: null }
  } catch (err) {
    const message = String(err.message ?? err)
    try {
      katex.renderToString(tex, { displayMode, strict: 'ignore', throwOnError: false })
      return { tier: 2, message }
    } catch {
      return { tier: 3, message }
    }
  }
}

console.log('=== how the pinned katex reports each case ===')
for (const [label, tex] of cases) {
  const r = strict(tex)
  console.log(`\n[${label}] tier ${r.tier}`)
  console.log(`  tex:     ${JSON.stringify(tex)}`)
  if (r.message) console.log(`  message: ${r.message}`)

  // Does the error text name the offending command, and can the command be recovered?
  const m = /Undefined control sequence:\s*(\\[A-Za-z@]+|\\[^A-Za-z])/.exec(r.message ?? '')
  if (m) {
    const cmd = m[1]
    console.log(`  names the command: ${JSON.stringify(cmd)}`)
    const stripped = tex.split(cmd).join(cmd.slice(1))
    const after = strict(stripped)
    console.log(`  made literal -> tier ${after.tier}${after.message ? ` (${after.message})` : ''}`)
  } else if (r.message) {
    console.log('  does NOT name a command')
  }
}

// The loop that a repair would run: replace the reported command, re-judge, repeat.
function repairUndefined(tex, displayMode = true, limit = 8) {
  const replaced = []
  let current = tex
  for (let i = 0; i < limit; i += 1) {
    const r = strict(current, displayMode)
    if (r.tier !== 2 && r.tier !== 3) return { ok: true, tex: current, replaced }
    const m = /Undefined control sequence:\s*(\\[A-Za-z@]+|\\[^A-Za-z])/.exec(r.message ?? '')
    if (!m) return { ok: false, tex, replaced: [], reason: `not an undefined command: ${r.message}` }
    const cmd = m[1]
    if (!current.includes(cmd)) return { ok: false, tex, replaced: [], reason: `command not found in source: ${cmd}` }
    current = current.split(cmd).join(cmd.slice(1))
    replaced.push(cmd)
  }
  return { ok: false, tex, replaced: [], reason: 'limit reached' }
}

console.log('\n\n=== repair loop ===')
for (const [label, tex] of cases) {
  const r = repairUndefined(tex)
  console.log(`[${label}] ok=${r.ok} replaced=${JSON.stringify(r.replaced)}${r.reason ? ` reason=${r.reason}` : ''}`)
  if (r.ok && r.tex !== tex) console.log(`  repaired: ${JSON.stringify(r.tex)}`)
}

// The decisive question for tier 2: does the LENIENT render of an unknown command
// silently drop it? Compare the two HTML outputs.
console.log('\n\n=== what the reader would actually see (tier 2) ===')
const lenient = katex.renderToString('\\foobar{x} = y', { displayMode: true, strict: 'ignore', throwOnError: false })
const literal = katex.renderToString('foobar{x} = y', { displayMode: true, strict: 'ignore', throwOnError: false })
console.log(`lenient drops the command silently: ${lenient.replace(/\s+/g, ' ').slice(0, 200)}`)
console.log(`literal text is visible instead:   ${literal.replace(/\s+/g, ' ').slice(0, 200)}`)
