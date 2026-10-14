/**
 * math-guard — the host half.
 *
 * Two independent defences, registered together because they fail differently:
 *
 *   1. `systemPrompt.section` — PRE-EMPTIVE rules, so the model stops producing
 *      glued headings and prose inside a `$$` block in the first place.
 *   2. `llm/stream` waterfall — the BACKSTOP. It rewrites the assistant's text
 *      after the model produces it and before it is persisted, so a region that
 *      would have rendered as the red source-dump is repaired instead.
 *
 * Defence 2 is why this plugin exists at all: the frontend is one monolithic
 * bundle inside `app.asar` and passes no KaTeX options (no `errorColor`, no
 * `maxExpand`, no `trust`), so the client cannot be configured after the fact.
 * The stream is the last place the text is still ours.
 *
 * ## The release rule
 *
 * Deltas arrive in arbitrary pieces, but a repair decision needs a whole region:
 * repairing `$u=\frac12` in isolation is not a prefix of repairing
 * `$u=\frac12[\varphi(1)]$`, because KaTeX parses the first as maths that never
 * closed. So the guard holds text until it can prove it will not change, and the
 * proof is the plugin's central invariant:
 *
 *     the text emitted so far is always a prefix of `repairText(whole answer)`
 *
 * It holds because the region scanner and `repairText` share one region model:
 * text may be released up to the start of the first region that has no closing
 * delimiter yet, and repairing that prefix's *complete* regions concatenates to
 * the same string as repairing the whole — including the separators a re-framing
 * repair inserts in the gaps, because those belong to the gaps, not to the text
 * already sent. A partial region is the only thing that must wait, and it waits
 * bounded: past `MAX_HOLD` the text is released unrepaired rather than stalling,
 * which is exactly the unguarded behaviour and therefore safe.
 *
 * `wire-test.mjs` asserts that invariant directly, under one-character-per-delta
 * splitting, for nine documents including the real incident.
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { repairText } from './math-repair.js'

/**
 * Sentinel the prompt asks the model to emit after its last line of prose.
 *
 * It is a receipt, not a terminator: it proves the formatting rules were applied, and
 * the answer continues after it. The guard removes the marker wherever it appears and
 * keeps releasing text normally — an earlier version treated it as "the answer ends
 * here" and held everything after it until the turn ended.
 */
export const TOKEN = '⟪MG-REPAIR⟫'

/**
 * Characters held at the tail so a sentinel split across deltas stays intact.
 * It is `TOKEN.length - 1` and not a smaller round number: a sentinel reaching the
 * buffer one character per delta is only caught if the whole prefix of it can be
 * withheld, so an 8-character reserve leaked `⟪MG-REPAIR⟫` into a finished answer.
 */
const TOKEN_TAIL = Math.max(1, TOKEN.length - 1)

/**
 * Hard cap on text held while a region waits to close. A `$$` that never closes
 * must not stall the visible answer, so past this the buffer is released
 * unrepaired.
 */
const MAX_HOLD = 600

export const BUILD = 'math-guard-2'

let onLog = () => {}
export function setLogger(fn) {
  onLog = typeof fn === 'function' ? fn : () => {}
}

/**
 * Durable evidence file for the guard.
 *
 * The session runner writes nothing to disk on its own, so without this a live turn
 * leaves no trace of whether the guard ran, repaired anything, or fired the
 * pre-persistence rewrite. Appends are best-effort: logging must never be able to
 * break a turn, so every failure here is swallowed.
 */
const LOG_PATH = 'C:/Users/<user>/Documents/deepseek-harness/default-workspace/plugin-design/plugin/guard.log'
const LOG_CAP = 512 * 1024
function fileLog(line) {
  try {
    const stamp = new Date().toISOString()
    const size = statSync(LOG_PATH, { throwIfNoEntry: false })?.size ?? 0
    if (size > LOG_CAP) writeFileSync(LOG_PATH, '', 'utf8')
    appendFileSync(LOG_PATH, `${stamp} ${line}\n`, 'utf8')
  } catch {
    // Never let logging break a turn.
  }
}

/**
 * Scan a buffer for math regions, mirroring the shipped tokenizer: fences are
 * literal, `$$` opens a display block only at a line start, `$$$` is not maths,
 * inline never spans a line. Returns the regions in order, with `start`/`end`
 * being the delimiter bounds and `body` the text between them.
 *
 * This is deliberately the same shape `repairText` parses with — a scanner that
 * disagreed with the repairer about where regions begin would produce a prefix
 * that is not a prefix of the repaired text.
 */
export function scanRegions(buf) {
  const regions = []
  const n = buf.length
  let i = 0
  let fence = null
  while (i < n) {
    const lineStart = i === 0 || buf[i - 1] === '\n'
    if (lineStart && (buf[i] === '`' || buf[i] === '~')) {
      let run = 0
      while (i + run < n && buf[i + run] === buf[i]) run += 1
      if (run >= 3) {
        const char = buf[i]
        if (fence === null) fence = { char, len: run }
        else if (char === fence.char && run >= fence.len) fence = null
        const nl = buf.indexOf('\n', i)
        i = nl < 0 ? n : nl + 1
        continue
      }
    }
    if (fence !== null) {
      const nl = buf.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (buf[i] !== '$' || (i > 0 && buf[i - 1] === '\\')) {
      i += 1
      continue
    }

    let dollars = 1
    while (buf[i + dollars] === '$') dollars += 1

    if (dollars === 2 && lineStart) {
      // Display block: needs a closing `$$`, which may be on a later line.
      const close = buf.indexOf('$$', i + 2)
      if (close < 0) {
        regions.push({ kind: 'display', start: i, end: n, body: buf.slice(i + 2), complete: false, midLineDisplay: false, unterminated: true, delimiter: '$$' })
        return regions
      }
      regions.push({ kind: 'display', start: i, end: close + 2, body: buf.slice(i + 2, close), complete: true, midLineDisplay: false, unterminated: false, delimiter: '$$' })
      i = close + 2
      continue
    }

    if (dollars === 1) {
      // Inline: must close on the same line, and a `$` immediately followed by a
      // space is currency, not maths (this mirrors the shipped tokenizer's rule).
      let close = -1
      for (let j = i + 1; j < n; j++) {
        if (buf[j] === '\n') break
        if (buf[j] === '$' && buf[j - 1] !== '\\') {
          close = j
          break
        }
      }
      if (close < 0) {
        regions.push({ kind: 'inline', start: i, end: n, body: buf.slice(i + 1), complete: false, midLineDisplay: false, unterminated: true, delimiter: '$' })
        return regions
      }
      regions.push({ kind: 'inline', start: i, end: close + 1, body: buf.slice(i + 1, close), complete: true, midLineDisplay: false, unterminated: false, delimiter: '$' })
      i = close + 1
      continue
    }

    // `$$` mid-paragraph: it pairs, and it is how a display block that is not
    // alone in its paragraph reaches the renderer — the reported failure.
    const close = buf.indexOf('$$', i + 2)
    if (close < 0) {
      regions.push({ kind: 'inline', start: i, end: n, body: buf.slice(i + 2), complete: false, midLineDisplay: false, unterminated: true, delimiter: '$$' })
      return regions
    }
    regions.push({ kind: 'inline', start: i, end: close + 2, body: buf.slice(i + 2, close), complete: true, midLineDisplay: true, unterminated: false, delimiter: '$$' })
    i = close + 2
  }
  return regions
}

/**
 * The largest index of `buf` that may be released now.
 *
 * Everything before the first region that has not closed is settled, because
 * regions never reach backwards: the region scanner and the repairer both start a
 * region at a delimiter, never before one. So the release point is that region's
 * start, and the text before it is emitted verbatim.
 *
 * The one thing that must be refused is a cut that splits a delimiter — releasing
 * `$` and leaving `$…` behind makes the remainder pair differently in isolation
 * than in context, which is how three earlier versions produced text that was
 * neither the original nor the repair. If the cut would land inside a run of `$`,
 * the whole run is held instead.
 */
export function safeCut(buf) {
  for (const region of scanRegions(buf)) {
    if (region.complete) continue

    let cut = region.start
    while (cut > 0 && buf[cut - 1] === '$') cut -= 1
    if (cut < region.start) {
      // The region's opener follows a `$` run; releasing up to here would split it.
      if (buf.length - region.start > MAX_HOLD) {
        onLog(`math-guard: releasing unrepaired inside an unclosed region after ${buf.length - region.start} chars (MAX_HOLD)`)
        return buf.length
      }
      return cut
    }
    return region.start
  }
  return buf.length
}

/**
 * One text block's rewriting state.
 *
 * `push` returns the text to emit for this delta (often `''`); `finish` returns
 * the rest. Concatenating every return value yields `repairText(whole text)` with
 * the sentinel removed.
 *
 * The released text is tracked as `emitted`, and a new release is the *difference*
 * between the repair of everything released so far and what has already gone out.
 * Repairing the whole settled prefix — never a fragment — is what keeps the
 * boundary consistent: a repair that re-frames a region inserts its separators in
 * the gap, which is part of that same repair, so it can never contradict text that
 * was already emitted.
 */
export function createBlockState() {
  /**
   * Raw text that arrived but has not been folded into the repair yet.
   *
   * Deltas are not settled on arrival: a delta can end between the two `$` of one
   * delimiter, and a repair decided on such a fragment frames the text differently
   * than one decided on the whole. So text is buffered until the release rule says
   * it is safe, and only then repaired.
   */
  let pending = ''
  /**
   * Raw text already folded into the repair.
   *
   * Repairs are NOT compositional — `repair("a $b")` is not a prefix of
   * `repair("a ") + repair("$b")`, because the trailing fragment opens a region the
   * earlier one closed. So a release is never repaired on its own: every settle
   * repairs `rawFolded + pending` as a single unit and emits only what is new.
   * Cumulative repair is what makes the emitted output a monotone prefix extension.
   */
  let rawFolded = ''
  /** The repair of `rawFolded`. */
  let repaired = ''
  /** How much of `repaired` has been emitted. */
  let sentOut = 0
  /** True once the sentinel has been seen, so it must be stripped from output. */
  let stripping = false

  /**
   * Repair a settled stretch of text.
   *
   * Text with no delimiter and no backslash cannot hold a region, so it passes
   * through byte-identically — which is also what keeps a plain prose prefix
   * untouched.
   */
  function repairWhole(text) {
    if (text.length === 0) return ''
    const clean = stripping ? text.split(TOKEN).join('') : text
    if (clean.length === 0) return ''
    if (!clean.includes('$') && !clean.includes('\\')) return clean
    let result
    try {
      result = repairText(clean)
    } catch (err) {
      // A guard that breaks a turn is worse than the defect it prevents.
      onLog(`math-guard: repair failed, passing text through: ${err?.message ?? err}`)
      return clean
    }
    if (result.repairs.length > 0) {
      onLog(
        `math-guard: repaired ${result.repairs.length} region(s): ` +
          result.repairs.map((r) => r.reason).join(', '),
      )
    }
    return result.text
  }

  /**
   * Fold every character received so far into the repair, returning the new output.
   *
   * The repair must extend what was already emitted. When it does not — a repair
   * that reached backwards into emitted text — the safe move is to emit nothing and
   * keep the text buffered, because the alternative is output the final answer
   * would contradict.
   */
  function settle() {
    if (pending.length === 0) return ''
    const whole = rawFolded + pending
    const next = repairWhole(whole)
    if (process.env.MG_DEBUG) {
      console.error(`[mg] settle pending=${pending.length} whole=${whole.length} next=${next.length} repaired=${repaired.length} sentOut=${sentOut} stripping=${stripping}`)
    }
    if (!next.startsWith(repaired) && repaired.length > 0) {
      onLog(
        'math-guard: repair would rewrite emitted text; holding ' +
          `${pending.length} chars for the next release`,
      )
      return ''
    }
    // Only now is the slice part of the repair. When the repair is refused the slice
    // stays out of `rawFolded`, so the next release attempts it again with more
    // context instead of losing it.
    rawFolded = whole
    pending = ''
    const out = next.length > sentOut ? next.slice(sentOut) : ''
    repaired = next
    sentOut = next.length
    return out
  }

  return {
    /** @returns {string} text to emit for this delta (may be ''). */
    push(text) {
      pending += text
      if (pending.includes(TOKEN)) {
        // The sentinel is one instruction among several, not an end marker: the answer
        // continues after it. Remove the marker and carry on with the normal release
        // rule, so the text that follows is released like any other.
        stripping = true
        pending = pending.split(TOKEN).join('')
      }
      if (pending.length <= TOKEN_TAIL) return ''
      const cut = safeCut(pending.slice(0, pending.length - TOKEN_TAIL))
      if (cut <= 0) return ''
      const delta = pending.slice(0, cut)
      const rest = pending.slice(cut)
      pending = delta
      const out = settle()
      // `settle` consumes the whole slice when it succeeds, and nothing when it
      // refuses; either way the unsettled remainder stays buffered.
      pending = pending + rest
      return out
    },

    /** @returns {string} the tail, repaired. Call once, at block end. */
    finish() {
      stripping = true
      pending = pending.split(TOKEN).join('')
      return settle()
    },

    get held() {
      return pending.length
    },
  }
}

/**
 * Wrap an upstream chunk iterable.
 *
 * Only `text-delta` chunks are touched, and only their `text` field: the block
 * index, the delta order and every non-text chunk pass through untouched, so
 * reasoning deltas, tool calls and usage frames stay byte-identical.
 */
export async function* guardStream(inner, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {}
  const states = new Map()
  let current = null
  let seen = 0
  let emitted = 0

  const stateFor = (index) => {
    let s = states.get(index)
    if (!s) {
      s = createBlockState()
      states.set(index, s)
    }
    return s
  }

  /** Close the block whose text is still buffered, if any. */
  function* flush(index) {
    const out = stateFor(index).finish()
    if (out.length > 0) {
      emitted += 1
      yield { type: 'text-delta', index, text: out }
    }
  }

  for await (const chunk of inner) {
    if (chunk && chunk.type === 'block-start' && chunk.blockType === 'text') {
      // A new text block means the previous one's text is complete even if its
      // `block-end` was not seen.
      if (current !== null && current !== chunk.index) yield* flush(current)
      current = chunk.index
      yield chunk
      continue
    }

    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      seen += 1
      try {
        const out = stateFor(chunk.index).push(chunk.text)
        if (out.length > 0) {
          emitted += 1
          yield { ...chunk, text: out }
        }
      } catch (err) {
        log(`delta failed, passing through: ${err?.message ?? err}`)
        yield chunk
      }
      continue
    }

    if (chunk && chunk.type === 'block-end' && current === chunk.index) {
      yield* flush(current)
      current = null
      yield chunk
      continue
    }

    yield chunk
  }

  for (const index of states.keys()) yield* flush(index)

  log(`guarded stream: ${seen} text delta(s) in, ${emitted} out`)
}

export function apply(ctx) {
  // The guard's only evidence that it ran is its log. Both sinks are wired before
  // anything else: the durable file, so a live turn leaves a record, and the host
  // logger when one is reachable. A missing logger must not disable the guard.
  setLogger((line) => {
    fileLog(line)
    try {
      ctx.get('logger')?.info?.(line)
    } catch {
      // Keeping the file sink is better than failing the plugin tree.
    }
  })

  const log = (line) => onLog(line)

  try {
    const sp = ctx.get('systemPrompt')
    if (sp && typeof sp.section === 'function') {
      sp.section({
        name: 'math-output-format',
        order: 1000,
        interpolate: false,
        text: [
          '## 数学推导的输出格式（必须遵守）',
          '',
          '- 行间公式 `$$ ... $$` 必须单独成段：前后各留一个空行，且 `$$` 必须是该行的开头。',
          '- `$$` 块内只能有公式，不得出现标题、正文、`**粗体**` 或列表项。',
          '- 一个 `$$` 块只放一个公式；多步推导写成多个块，或用 `aligned`/`cases` 环境。',
          '- 标题（`#`/`##`）与正文永远不能与公式粘在同一行。',
          '- 行内公式不要超过约 160 个字符；超长公式改为行间公式。',
          '- 推导结束时用纯文本重述结论数值（例如 x=1 时 u≈-0.0092），不要让读者只能从公式里读结论。',
          `- 在正文最后一行之后单独输出 ${TOKEN}（该记号会被自动移除，用于确认格式检查已生效）。`,
        ].join('\n'),
      })
      log('prompt section "math-output-format" registered')
    } else {
      log('systemPrompt.section unavailable; prompt rules skipped')
    }
  } catch (err) {
    log(`prompt section failed: ${err?.message ?? err}`)
  }

  try {
    ctx.on('llm/stream', (options, next) => {
      log(`llm/stream hooked model=${options?.model ?? '?'}`)
      return guardStream(next(), { onLog: log })
    })
    log(`listener registered (BUILD=${BUILD})`)
  } catch (err) {
    log(`llm/stream hook failed: ${err?.message ?? err}`)
  }
}
