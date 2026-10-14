/**
 * Oracle-based math repair — parser-faithful regions, renderer-verified verdicts.
 *
 * WHY DETECTION IS NOT A REGEX
 *   A measured A/B run (`katex-ab.mjs`, 31 cases) showed the obvious heuristics are
 *   wrong in both directions: a 300-character formula, an 8-deep `\underbrace` chain,
 *   `\substack`, and Chinese inside maths all render fine, while a 99-character formula
 *   died. Length, brace depth and "heavy constructs" predict nothing, so detection asks
 *   the renderer instead of guessing.
 *
 * WHY REGIONS ARE CUT THE WAY THEY ARE
 *   Version 1 judged each `$$…$$` by the body BETWEEN the delimiters. It asked KaTeX a
 *   question the client never asks, and reported zero defects in genuinely broken text.
 *   Version 2 over-corrected and flagged every region, because its structural rules
 *   matched the delimiters it had included itself. Both mistakes came from guessing how
 *   delimiters pair.
 *
 *   The pairing rule is not a guess: it ships in `dsh-client-ui-primitives` as
 *   `createMathFlow`, a micromark syntax extension. Read out of the bundle, it says:
 *
 *     - `$$` opens a FLOW construct entered as `mathFlow` + `mathFlowFence`;
 *     - `afterDollarOpen` calls `nok` when a THIRD `$` follows, so `$$$` is not maths;
 *     - the construct continues across line endings, so a `$$` block may span lines;
 *     - closing is attempted with `tokenizeClosingFence`, the same fence shape.
 *
 *   A flow construct is only dispatched at a line prefix. So a `$$` in the middle of a
 *   paragraph cannot open a display block, and the delimiters pair one off from there —
 *   which is exactly the reported failure. This module mirrors that shape: `$$` is
 *   display maths only at a line start, and a region is judged by the WHOLE fenced text
 *   the renderer would receive.
 *
 * WHAT A REPAIR DOES
 *   It never deletes mathematics and never touches source the renderer accepted. A
 *   rejected region is released as a fenced block, or with its delimiters removed, so
 *   the reader sees the formula source — recoverable and copyable — instead of a red
 *   error span, and fenced content is not re-parsed as maths.
 *
 * @module tex-repair
 */

import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

/** The colour KaTeX paints an error in when `errorColor` is left at its default. */
export const ERROR_COLOR = '#cc0000'

/**
 * Oracle state. Resolved on first use rather than at import time, because the config
 * that says which KaTeX to load only exists once the plugin is applied.
 */
let katex = null
let katexVersion = null
let katexEntry = null
let loadError = null
let loadPromise = null
let options = { katexPath: '', macros: {}, hostDir: '' }

/**
 * Point the oracle at a specific renderer build and macro set.
 *
 * Called by the plugin during `apply`, before any text is judged. Kept separate from
 * {@link judge} so the module stays usable standalone (the test suite calls `judge` with
 * no plugin at all) while the plugin can pin the same build the client uses.
 *
 * @param {{ katexPath?: string, macros?: Record<string, string>, hostDir?: string }} next
 */
export function setOracleOptions(next = {}) {
  options = {
    katexPath: typeof next.katexPath === 'string' ? next.katexPath : '',
    macros: next.macros && typeof next.macros === 'object' ? next.macros : {},
    hostDir: typeof next.hostDir === 'string' ? next.hostDir : '',
  }
  loadPromise = null
  katex = null
  katexVersion = null
  katexEntry = null
  loadError = null
}

/**
 * The host profile's `node_modules`, used as an extra resolution root.
 *
 * @returns {string}
 */
function defaultHostDir() {
  const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
  return `${home.replace(/[\\/]+$/, '')}/profiles/desktop`
}

/**
 * Candidate ways to reach the renderer, most specific first.
 *
 * The `require.resolve` candidates exist because of a measured failure: importing a
 * DIRECTORY (`import('file:///…/node_modules/katex')`) is not supported by the ESM loader,
 * and KaTeX 0.16.47 is ESM-first so `import('katex')` from a checkout does not reach the
 * profile either. Resolving the package entry the way Node itself would — with a
 * `createRequire` seeded at the directory in question — is what makes the oracle find the
 * same build the client renders with, without naming a file inside the package (which
 * would break on the next KaTeX release).
 *
 * @returns {string[]}
 */
function candidates() {
  const list = []
  const add = (value) => {
    if (value && !list.includes(value)) list.push(value)
  }
  if (options.katexPath) {
    // A configured path may be the package directory or its entry file.
    add(existsSync(`${options.katexPath.replace(/[\\/]+$/, '')}/package.json`) ? options.katexPath : options.katexPath)
  }
  for (const base of [options.hostDir, defaultHostDir()]) {
    if (!base) continue
    try {
      add(createRequire(`${base.replace(/[\\/]+$/, '')}/package.json`).resolve('katex'))
    } catch {
      /* the profile may not carry katex; the bare specifier below is the fallback */
    }
  }
  add('katex')
  return list
}

/**
 * Turn a candidate into something `import()` accepts.
 *
 * The drive-letter case is why this is not a one-line check: `C:\…\katex.js` looks like a
 * URL scheme (`C:`) to a naive test, so a Windows path was handed to `import()` unchanged
 * and rejected with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A single-letter prefix followed by a
 * separator is a path, not a scheme.
 *
 * @param {string} candidate
 * @returns {string}
 */
function toSpecifier(candidate) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) return candidate // a real URL
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) return pathToFileURL(candidate).href // a Windows path
  if (/^[\\/]/.test(candidate)) return pathToFileURL(candidate).href // a POSIX path
  return candidate // a bare specifier: let the resolver decide
}

/**
 * Load the renderer.
 *
 * Resolution order matters: a configured path wins, then the host profile's own resolution
 * (the shipped build, which is what the client renders with), then a plain `katex`
 * specifier for a consumer whose own tree carries it. Every failure is collected instead
 * of thrown — a plugin that cannot find KaTeX must still let the turn through, just
 * without repairs.
 *
 * `entry` is reported because a probe may want to load the very same build itself (the test
 * suite does, from the package root); it is the resolved specifier, so it is a file path or
 * URL rather than the configured value, and it stays null while the oracle is unavailable.
 *
 * @returns {Promise<{ available: boolean, version: string | null, entry: string | null, error: string | null }>}
 */
export async function loadOracle() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const attempts = []
    for (const candidate of candidates()) {
      try {
        const mod = await import(toSpecifier(candidate))
        const api = mod?.default ?? mod
        if (typeof api?.renderToString === 'function') {
          katex = api
          katexVersion = api.version ?? '(unknown)'
          katexEntry = candidate
          loadError = null
          return { available: true, version: katexVersion, entry: katexEntry, error: null }
        }
        attempts.push(`${candidate}: no renderToString`)
      } catch (err) {
        attempts.push(`${candidate}: ${err?.message ?? err}`)
      }
    }
    katex = null
    katexEntry = null
    loadError = new Error(`no usable katex found (${attempts.join('; ')})`)
    return { available: false, version: null, entry: null, error: loadError.message }
  })()
  return loadPromise
}

/**
 * What the oracle found, for a log line or a health check.
 *
 * @returns {Promise<{ available: boolean, version: string | null, entry: string | null, error: string | null }>}
 */
export async function oracleStatus() {
  return loadOracle()
}

/**
 * Truthy once the oracle could be loaded. Kept as a promise-shaped helper because loading
 * is asynchronous; `apply` awaits it so the synchronous stream path never has to.
 *
 * @returns {Promise<boolean>}
 */
export async function ensureOracle() {
  const status = await loadOracle()
  return status.available
}

/**
 * Snapshot of the oracle, for a diagnostic that cannot await. Call {@link loadOracle}
 * first; before that this reports "not loaded yet" rather than guessing.
 */
export function oracleSnapshot() {
  return { available: katex !== null, version: katexVersion, entry: katexEntry, error: loadError?.message ?? null }
}

/**
 * The renderer's error colour appearing in the output means the reader is looking at a
 * red blob, whatever the call did.
 *
 * WHY THIS IS A SEPARATE SIGNAL: an earlier version treated "the strict call succeeded"
 * as proof the region renders. It does not. Measured on the pinned KaTeX,
 * `\htmlClass{red}{x}` passes strict mode and still renders `\htmlClass` in `#cc0000`
 * (HTML extensions are disabled, so the command has no effect and the renderer falls
 * back to showing it). Judging by the output rather than by the absence of a throw is
 * the only way to catch that.
 *
 * @param {string} html
 */
export function rendersRed(html) {
  return typeof html === 'string' && html.includes(ERROR_COLOR)
}

/**
 * Ask the renderer what it thinks of one maths region — the same call the client makes.
 *
 * `html` is returned alongside the verdict because the caller has to tell a red render
 * from a clean one; `ok` alone cannot express that (see {@link rendersRed}).
 *
 * @param {string} tex
 * @param {boolean} displayMode
 * @returns {{ ok: boolean, html: string | null, red: boolean, position: number | null, message: string | null }}
 */
export function judge(tex, displayMode) {
  if (!katex) {
    const status = oracleSnapshot()
    return {
      ok: false,
      html: null,
      red: false,
      position: null,
      message: `oracle unavailable: ${status.error ?? 'not loaded yet (await loadOracle() first)'}`,
    }
  }
  const shared = { displayMode, macros: options.macros }
  let html = null
  try {
    html = katex.renderToString(tex, { ...shared, throwOnError: true })
  } catch (err) {
    // The product's second arm: `strict:'ignore'` plus `throwOnError:false`. It never
    // throws; on a parse error it returns html with the message in the error colour.
    try {
      html = katex.renderToString(tex, { ...shared, strict: 'ignore', throwOnError: false })
    } catch {
      html = null
    }
    const message = String(err?.message ?? err)
    const m = /at position (\d+)/.exec(message)
    return { ok: false, html, red: rendersRed(html), position: m ? Number(m[1]) : null, message }
  }
  return { ok: true, html, red: rendersRed(html), position: null, message: null }
}

/**
 * Recover the source text KaTeX echoed into an error span.
 *
 * On a parse error KaTeX puts the offending token in an `<mtext>` (and the whole input
 * in the annotation). That echoed token is the ONLY reliable handle on what went wrong:
 * it is the renderer's own account of the problem, so the repair never has to
 * re-implement its error reporting.
 *
 * @param {string} html
 * @returns {string | null}
 */
export function echoedErrorText(html) {
  if (typeof html !== 'string') return null
  const m = /<mtext[^>]*>([\s\S]*?)<\/mtext>/.exec(html)
  if (!m) return null
  const text = m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
  return text.length > 0 ? text : null
}

/**
 * True when only spaces/tabs precede this offset on its line.
 * A flow construct is dispatched at a line prefix, so this decides display vs inline.
 *
 * @param {string} text
 * @param {number} i
 */
function atLineStart(text, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = text[j]
    if (c === '\n') return true
    if (c !== ' ' && c !== '\t' && c !== '\r') return false
  }
  return true
}

/**
 * Find maths regions the way the shipped tokenizer does.
 *
 * Display: `$$` at a line start (not `$$$`), closed by the next `$$`, spanning lines.
 * Inline: a single `$` not escaped, closed by the next `$`.
 *
 * @param {string} text
 * @returns {Array<{ kind: 'display' | 'inline', start: number, end: number, raw: string, body: string, delimiter: string, unterminated: boolean, midLineDisplay: boolean }>}
 */
export function findMathRegions(text) {
  const regions = []
  const n = text.length
  let i = 0
  let fence = null
  while (i < n) {
    // Fenced code is literal: `$` inside it must never be read as a delimiter. A repair
    // emits fences, so a fence-blind scanner would re-scan its own output and find new
    // "regions" in text that is inert (this actually happened — a repaired block
    // produced an unterminated region in a test).
    if (atLineStart(text, i) && (text[i] === '`' || text[i] === '~')) {
      const marker = text[i]
      let run = 0
      while (i + run < n && text[i + run] === marker) run += 1
      if (run >= 3) {
        const token = marker.repeat(run)
        const lineEnd = text.indexOf('\n', i)
        const rest = lineEnd < 0 ? text.slice(i) : text.slice(i, lineEnd)
        if (fence === null) {
          fence = { token, marker }
        } else if (marker === fence.marker && run >= fence.token.length && rest.trim() === token) {
          fence = null
        }
        i = lineEnd < 0 ? n : lineEnd + 1
        continue
      }
    }
    if (fence !== null) {
      const lineEnd = text.indexOf('\n', i)
      i = lineEnd < 0 ? n : lineEnd + 1
      continue
    }
    if (text[i] !== '$' || (i > 0 && text[i - 1] === '\\')) {
      i += 1
      continue
    }
    const isDD = text.startsWith('$$', i) && !text.startsWith('$$$', i)
    const display = isDD && atLineStart(text, i)
    /** A `$$` that pairs correctly but sits mid-paragraph: display intent, inline parsing. */
    const midLineDisplay = isDD && !display
    const delim = isDD ? '$$' : '$'
    const bodyStart = i + delim.length

    let j = bodyStart
    let close = -1
    while (j < n) {
      if (text[j] === '\\') {
        j += 2
        continue
      }
      if (!display && !midLineDisplay && text[j] === '\n') break // inline maths never spans a line
      if (text.startsWith(delim, j)) {
        close = j
        break
      }
      j += 1
    }
    const end = close < 0 ? n : close + delim.length
    regions.push({
      kind: display ? 'display' : 'inline',
      start: i,
      end,
      raw: text.slice(i, end),
      delimiter: delim,
      body: close < 0 ? text.slice(bodyStart) : text.slice(bodyStart, close),
      unterminated: close < 0,
      midLineDisplay,
    })
    i = end
  }
  return regions
}

/**
 * Try to make a region render without the error colour, using the renderer's own echo
 * of the problem as the handle.
 *
 * Only TWO moves are allowed, both of which keep the reader's content visible:
 *   - a command the renderer does not know (`\foobar`, or `\htmlClass` when extensions
 *     are disabled) loses its backslash, so the reader sees `foobar` instead of a red
 *     `\foobar`;
 *   - an operator that got doubled (`x_1_2`) keeps its first argument and takes the
 *     rest as a group (`x_{1_2}`).
 * Anything else is left alone: guessing at structural damage is how a repair invents
 * mathematics the author never wrote. The caller degrades those to a fenced source
 * block, where the reader still sees the original text.
 *
 * Each candidate is re-rendered and accepted only if the red is gone AND the strict
 * call now succeeds. That double condition is why this cannot loop forever on a change
 * that merely moves the error: a candidate that is still red is discarded.
 *
 * @param {string} body
 * @param {boolean} displayMode
 * @returns {{ ok: boolean, body: string, moves: string[] }}
 */
export function recoverRedRegion(body, displayMode) {
  let current = body
  const moves = []
  const MAX_MOVES = 8
  for (let i = 0; i < MAX_MOVES; i += 1) {
    const verdict = judge(current, displayMode)
    if (verdict.ok && !verdict.red) return { ok: true, body: current, moves }

    const echo = echoedErrorText(verdict.html)
    if (echo === null) return { ok: false, body, moves: [] }

    let candidate = null
    // A control sequence the renderer cannot use. Longest-name-first is not needed:
    // KaTeX names exactly one command per error.
    if (/^\\[A-Za-z@]+$/.test(echo) && current.includes(echo)) {
      candidate = current.split(echo).join(echo.slice(1))
      moves.push(`command ${echo} -> ${echo.slice(1)}`)
    } else {
      const m = /^(.*?)_([^_{}]+)_(.*)$/s.exec(echo)
      if (m && current.includes(echo)) {
        const [whole, before, first, rest] = m
        candidate = current.replace(whole, `${before}_{${first}_${rest}}`)
        moves.push('double subscript -> grouped subscript')
      }
    }
    if (candidate === null || candidate === current) return { ok: false, body, moves: [] }
    current = candidate
  }
  return { ok: false, body, moves: [] }
}

/**
 * Faults that suggest delimiters paired wrongly. Each rule is applied to the region BODY
 * only — never to the delimiters, which are the region's own framing and would otherwise
 * match every rule (the version-2 false positive).
 *
 * These are SYMPTOMS, not verdicts. See {@link releasesCleanly}.
 */
const STRUCTURAL_RULES = [
  { id: 'heading-inside', re: /(^|\n)[ \t]{0,3}#{1,6}[ \t]/, why: 'a Markdown heading was swallowed into the maths' },
  { id: 'list-inside', re: /(^|\n)[ \t]{0,3}([-*+]|\d+\.)[ \t]+\S/, why: 'a Markdown list item was swallowed into the maths' },
  { id: 'blank-line-inside', re: /\n[ \t]*\n/, why: 'a blank line ends the paragraph, so this cannot be one formula' },
  { id: 'delimiter-inside', re: /(?<!\\)\$\$?/, why: 'a maths delimiter is left inside the region, so pairing is off by one' },
]

/**
 * Would the region render if it were re-framed the way {@link releaseRegion} re-frames it?
 *
 * WHY THIS EXISTS — a measured false positive that reached a real transcript. Structural rules
 * were treated as verdicts, so a region whose delimiter pairing looks odd was flagged and
 * "repaired" even when the renderer accepted it. `$$\text{$\alpha$ 是闭 1-形式}$$` is the case:
 * the pairing heuristic starts a new region at the `$` inside `\text{…}`, so the first region
 * ends there and the rest looks like damage — but KaTeX renders `\text{$\alpha$ …}` without
 * complaint, and the reader saw a perfectly good formula. Worse, the re-framing then split the
 * text so that a *new* region opened around the second `$` and ran on, so the "repair" made the
 * verdict worse rather than better.
 *
 * So the renderer keeps the last word: a pattern match is only actionable when the released
 * form would still be rejected. This mirrors what {@link releaseRegion} itself checks — it
 * re-frames a display region only when the body renders cleanly — so the verdict and the
 * repair now agree by construction instead of by coincidence.
 *
 * @param {{kind: string, body: string, midLineDisplay?: boolean}} region
 * @returns {boolean} true when the re-framed region renders with no error colour
 */
function releasesCleanly(region) {
  if (!katex) return true // no renderer: no structural verdict either
  const displayMode = region.kind === 'display' || Boolean(region.midLineDisplay)
  const asIs = judge(region.body, displayMode)
  if (displayMode && asIs.ok && !asIs.red) return true
  return recoverRedRegion(region.body, displayMode).ok
}

/**
 * The TeX the renderer actually hands to KaTeX: the region body, delimiters removed.
 *
 * This is the single most error-prone detail in the whole module. Every wrong version
 * got it wrong in a different way — judging only the body (missed the pairing fault),
 * judging the raw region including `$$` (flagged every valid formula, because KaTeX has
 * no idea what a Markdown delimiter is), and applying structural rules to the raw region
 * (matched its own framing). So it lives in exactly one place, and the guard test
 * asserts that a valid formula survives untouched.
 *
 * @param {{body: string}} region
 * @returns {string}
 */
export function texOf(region) {
  return region.body
}

/**
 * Decide whether one region must be repaired, and why.
 *
 * @param {{kind: string, body: string, raw: string, unterminated?: boolean, delimiter?: string, midLineDisplay?: boolean}} region
 * @returns {{ verdict: 'ok' | 'repair', reason: string | null, detail: string | null }}
 */
export function inspect(region) {
  if (!katex) {
    // No renderer, no verdict. Reporting "repair" here would be a guess, and a guess that
    // fences every formula in the answer — far worse than the defect being prevented. The
    // plugin awaits {@link loadOracle} during `apply`, so this is a fallback, not the norm.
    return { verdict: 'ok', reason: null, detail: 'oracle unavailable' }
  }
  if (region.unterminated) {
    return { verdict: 'repair', reason: 'unterminated', detail: 'the region has no closing delimiter' }
  }
  for (const rule of STRUCTURAL_RULES) {
    const m = rule.re.exec(region.body)
    if (m) {
      // The pattern is only a reason to act if the re-framed form would still fail.
      if (releasesCleanly(region)) {
        return { verdict: 'ok', reason: null, detail: `${rule.id} pattern seen but the renderer accepts it` }
      }
      return { verdict: 'repair', reason: rule.id, detail: `${rule.why} (matched ${JSON.stringify(m[0].slice(0, 24))})` }
    }
  }
  if (region.midLineDisplay) {
    // The delimiters pair, but they pair as INLINE maths, so KaTeX receives the
    // delimiters as part of the TeX and rejects them. Judge the body as the author
    // intended it (display) to decide whether it can be re-framed.
    const asDisplay = judge(region.body, true)
    return asDisplay.ok && !asDisplay.red
      ? { verdict: 'repair', reason: 'mid-paragraph-display', detail: 'a display block was opened mid-paragraph, so the delimiters did not pair as display maths' }
      : { verdict: 'repair', reason: 'oracle-rejected', detail: asDisplay.message }
  }
  const displayMode = region.kind === 'display'
  const verdict = judge(texOf(region), displayMode)
  if (!verdict.ok) {
    return { verdict: 'repair', reason: 'oracle-rejected', detail: verdict.message }
  }
  if (verdict.red) {
    // The strict call succeeded and the reader is STILL looking at a red blob: the
    // renderer drew its own error message into the output. This is the case an
    // "did it throw?" oracle reports as fine, so it is checked separately.
    return {
      verdict: 'repair',
      reason: 'red-render',
      detail: `the renderer painted the error colour: ${JSON.stringify(echoedErrorText(verdict.html) ?? '')}`,
    }
  }
  return { verdict: 'ok', reason: null, detail: null }
}

/**
 * Release a region as text the renderer will not paint red.
 *
 * Order matters, and every step keeps the mathematics rather than deleting it:
 *   1. a region whose only problem was framing is re-framed and rendered normally;
 *   2. a region the renderer can be talked out of failing (unknown command, doubled
 *      operator) is repaired and rendered, with the substitution visible in the maths;
 *   3. everything else is fenced as source, so the reader still sees the formula.
 *
 * An unterminated region has no real body to fence, so its own text is emitted as-is —
 * fencing it would invent a boundary the renderer never saw.
 *
 * @param {{body: string, kind?: string, unterminated?: boolean, midLineDisplay?: boolean, delimiter?: string}} region
 * @returns {string}
 */
export function releaseRegion(region) {
  const body = region.body.replace(/^\n+|\n+$/g, '')
  // An unterminated INLINE region is just a stray `$` in prose; emitting its body is the
  // whole repair. An unterminated DISPLAY region still has a delimiter that would
  // re-enter maths, so its body is fenced to stop that from happening.
  if (region.unterminated && region.delimiter !== '$$') return region.body

  const displayMode = region.kind === 'display' || Boolean(region.midLineDisplay)
  if (!katex) return region.body // no renderer: leave the text exactly as it arrived
  const asIs = judge(body, displayMode)
  if (displayMode && asIs.ok && !asIs.red) {
    // The mathematics is valid; only its framing was wrong. Re-frame it as a proper
    // display block instead of degrading it to source, so the reader keeps the rendered
    // formula.
    return `\n\n$$\n${body}\n$$\n\n`
  }

  const recovered = recoverRedRegion(body, displayMode)
  if (recovered.ok) {
    // The repaired TeX is re-framed exactly like a healthy region, so the reader sees a
    // rendered formula rather than a red span.
    return region.kind === 'display' || region.midLineDisplay
      ? `\n\n$$\n${recovered.body}\n$$\n\n`
      : `$${recovered.body}$`
  }

  return `\n\n\`\`\`\n${body}\n\`\`\`\n\n`
}

/**
 * Repair every math region in a text fragment.
 *
 * Pure and synchronous on purpose: it is called from a stream transform, where a throw
 * would damage a real turn. It never throws — any internal failure returns the input
 * unchanged, because passing text through is always safer than blocking it.
 *
 * @param {string} text
 * @returns {{ text: string, repairs: Array<{ kind: string, reason: string | null, detail: string | null, before: string, after: string }> }}
 */
export function repairText(text) {
  const repairs = []
  try {
    if (typeof text !== 'string' || text === '' || !text.includes('$')) {
      return { text: typeof text === 'string' ? text : '', repairs }
    }
    const regions = findMathRegions(text)
    if (regions.length === 0) return { text, repairs }

    let out = ''
    let cursor = 0
    let touched = false
    for (const region of regions) {
      const { verdict, reason, detail } = inspect(region)
      if (verdict === 'ok') continue
      const replacement = releaseRegion(region)
      repairs.push({
        kind: region.kind,
        reason,
        detail,
        before: text.slice(region.start, Math.min(region.end, region.start + 120)),
        after: replacement.trim().slice(0, 120),
      })
      out += text.slice(cursor, region.start) + replacement
      cursor = region.end
      touched = true
    }
    if (!touched) return { text, repairs }
    out += text.slice(cursor)
    return { text: out, repairs }
  } catch (err) {
    return { text, repairs: [{ kind: 'internal', reason: 'error', detail: String(err?.message ?? err), before: '', after: '' }] }
  }
}

/**
 * Would the renderer paint any of this red, and can it be repaired?
 *
 * A convenience wrapper for a health check: it reports the verdict without producing
 * replacement text, so a diagnostic can quote the reason a region was flagged.
 *
 * @param {string} text
 * @returns {{ regions: number, flagged: Array<{ kind: string, reason: string | null, detail: string | null, before: string }> }}
 */
export function inspectText(text) {
  const flagged = []
  let regions = 0
  try {
    if (typeof text !== 'string' || !text.includes('$')) return { regions, flagged }
    const found = findMathRegions(text)
    regions = found.length
    for (const region of found) {
      const { verdict, reason, detail } = inspect(region)
      if (verdict === 'ok') continue
      flagged.push({
        kind: region.kind,
        reason,
        detail,
        before: text.slice(region.start, Math.min(region.end, region.start + 120)),
      })
    }
  } catch {
    /* a diagnostic never throws */
  }
  return { regions, flagged }
}
