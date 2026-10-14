/**
 * dsh-math-tex — the stream guard (host half).
 *
 * Two independent defences, registered together because they fail differently:
 *
 *   1. `systemPrompt.section` — PRE-EMPTIVE rules, so the model stops producing glued
 *      headings and prose inside a `$$` block in the first place.
 *   2. `llm/stream` waterfall — the BACKSTOP. It rewrites the assistant's text after the
 *      model produces it and before it is persisted, so a region that would have
 *      rendered as the red source-dump is repaired instead.
 *
 * Defence 2 is why this plugin exists at all: the frontend is one monolithic bundle
 * inside `app.asar` and passes no KaTeX options (no `errorColor`, no `maxExpand`, no
 * `trust`), so the client cannot be configured after the fact. The stream is the last
 * place the text is still ours.
 *
 * THE RELEASE RULE
 *
 * Deltas arrive in arbitrary pieces, but a repair decision needs a whole region:
 * repairing `$E=mc^2` in isolation is not a prefix of repairing
 * `$E=mc^2=9\times10^{16}$`, because KaTeX parses the first as maths that never closed.
 * So the guard holds text until it can prove it will not change, and the proof is the
 * plugin's central invariant:
 *
 *     the text emitted so far is always a prefix of `repairText(whole answer)`
 *
 * It holds because the safety cut and the repairer share ONE region model — region
 * scanning is not re-implemented here, it is imported from `./tex-repair.js`. Text may
 * be released up to the start of the first region that has no closing delimiter yet, and
 * repairing that prefix's complete regions concatenates to the same string as repairing
 * the whole, including the separators a re-framing repair inserts in the gaps, because
 * those belong to the gaps rather than to the text already sent. A partial region is the
 * only thing that must wait, and it waits bounded: past `maxHold` the text is released
 * unrepaired rather than stalling, which is exactly the unguarded behaviour and
 * therefore safe.
 *
 * `test/wire-test.mjs` asserts that invariant directly, under one-character-per-delta
 * splitting, for nine documents including the real incident.
 *
 * @module guard
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { repairText, findMathRegions, setOracleOptions, loadOracle } from './tex-repair.js'
import { resolveConfig } from './config.js'

/**
 * Completion marker the prompt asks the model to emit after its last line of prose.
 *
 * It is a receipt, not a terminator: it proves the formatting rules were applied, and
 * the answer continues after it. The guard removes the marker wherever it appears and
 * keeps releasing text normally — an earlier version treated it as "the answer ends
 * here" and held everything after it until the turn ended.
 *
 * A guard loaded without the prompt rules still strips this marker, so a model that was
 * told about it by an older prompt cannot leak it into an answer.
 */
export const TOKEN = '⟪MG-REPAIR⟫'

export const BUILD = 'dsh-math-tex-1'

/** Rules injected into the system prompt. Kept as data so `promptRules` can select a subset. */
const PROMPT_RULES = {
  full: [
    '## 数学推导的输出格式（必须遵守）',
    '',
    '- 行间公式 `$$ ... $$` 必须单独成段：前后各留一个空行，且 `$$` 必须是该行的开头。',
    '- `$$` 块内只能有公式，不得出现标题、正文、`**粗体**` 或列表项。',
    '- 一个 `$$` 块只放一个公式；多步推导写成多个块，或用 `aligned`/`cases` 环境。',
    '- 标题（`#`/`##`）与正文永远不能与公式粘在同一行。',
    '- 行内公式不要超过约 160 个字符；超长公式改为行间公式。',
    '- 推导结束时用纯文本重述结论数值（例如 x=1 时 u≈-0.0092），不要让读者只能从公式里读结论。',
    `- 在正文最后一行之后单独输出 ${TOKEN}（该记号会被自动移除，用于确认格式检查已生效）。`,
  ],
  // The two rules that prevent the reported failure on their own. Everything else in
  // `full` is about readability, and a host with its own style rules may not want it.
  minimal: [
    '## 数学公式格式（必须遵守）',
    '',
    '- 行间公式 `$$ ... $$` 必须单独成段：前后各留一个空行，且 `$$` 必须是该行的开头。',
    '- `$$` 块内只能有公式，不得出现标题、正文、`**粗体**` 或列表项。',
  ],
}

let onLog = () => {}
export function setLogger(fn) {
  onLog = typeof fn === 'function' ? fn : () => {}
}

/** Active config for this process. Set by {@link apply}; defaults keep the module standalone. */
let active = resolveConfig(undefined).config

/** Guard log rotation cap, so a long-lived host cannot grow the file without bound. */
const LOG_CAP = 512 * 1024

/**
 * Append to the guard log.
 *
 * The session runner writes nothing to disk on its own, so without this a live turn
 * leaves no trace of whether the guard ran, repaired anything, or fired the
 * pre-persistence rewrite. Appends are best-effort: logging must never be able to break
 * a turn, so every failure here is swallowed.
 *
 * @param {string} path absolute path, or '' to disable
 * @param {string} line
 */
function appendLog(path, line) {
  if (!path) return
  try {
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    if (size > LOG_CAP) writeFileSync(path, '', 'utf8')
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Never let logging break a turn.
  }
}

/**
 * Scan a buffer for maths regions, mirroring the shipped tokenizer.
 *
 * This is a re-export of the repairer's own scanner rather than a second implementation.
 * An earlier draft kept a near-copy here, and the two drifted: the guard treated a fence
 * as a fence only at column 0 while the repairer allowed indentation, so a release point
 * could land where the repairer saw a region — precisely the disagreement the central
 * invariant forbids. Sharing one function makes that class of bug unrepresentable.
 *
 * @param {string} buf
 * @returns {ReturnType<typeof findMathRegions>}
 */
export function scanRegions(buf) {
  return findMathRegions(buf)
}

/**
 * The largest index of `buf` that may be released now.
 *
 * Everything before the first region that has not closed is settled, because regions
 * never reach backwards: the scanner and the repairer both start a region at a delimiter,
 * never before one. So the release point is that region's start, and the text before it
 * is emitted verbatim.
 *
 * The one thing that must be refused is a cut that splits a delimiter — releasing `$` and
 * leaving `$…` behind makes the remainder pair differently in isolation than in context,
 * which is how three earlier versions produced text that was neither the original nor
 * the repair. If the cut would land inside a run of `$`, the whole run is held instead.
 *
 * @param {string} buf
 * @returns {number}
 */
export function safeCut(buf) {
  for (const region of scanRegions(buf)) {
    if (region.complete !== false && !region.unterminated) continue

    let cut = region.start
    while (cut > 0 && buf[cut - 1] === '$') cut -= 1
    if (cut < region.start) {
      // The region's opener follows a `$` run; releasing up to here would split it.
      if (buf.length - region.start > active.maxHold) {
        onLog(`releasing unrepaired inside an unclosed region after ${buf.length - region.start} chars (maxHold)`)
        return buf.length
      }
      return cut
    }
    return region.start
  }
  return buf.length
}

/** True when a region record describes something still waiting to close. */
function isOpen(region) {
  return region.unterminated === true || region.complete === false
}

/**
 * One text block's rewriting state.
 *
 * `push` returns the text to emit for this delta (often `''`); `finish` returns the rest.
 * Concatenating every return value yields `repairText(whole text)` with the marker
 * removed.
 *
 * The released text is tracked as `emitted`, and a new release is the *difference*
 * between the repair of everything released so far and what has already gone out.
 * Repairing the whole settled prefix — never a fragment — is what keeps the boundary
 * consistent: a repair that re-frames a region inserts its separators in the gap, which
 * is part of that same repair, so it can never contradict text that was already emitted.
 *
 * @param {{ maxHold?: number, tailBuffer?: number, repairMode?: 'auto' | 'check-only' | 'off', debug?: boolean, log?: (line: string) => void }} [opts]
 */
export function createBlockState(opts = {}) {
  const maxHold = Number.isInteger(opts.maxHold) ? opts.maxHold : active.maxHold
  const tailBuffer = Number.isInteger(opts.tailBuffer) ? opts.tailBuffer : Math.max(1, active.tailBuffer)
  const repairMode = opts.repairMode ?? (active.repair === 'off' ? 'off' : active.repair)
  const debug = opts.debug ?? process.env.DSH_MATH_TEX_DEBUG === '1'
  const log = typeof opts.log === 'function' ? opts.log : onLog

  /**
   * Raw text that arrived but has not been folded into the repair yet.
   *
   * Deltas are not settled on arrival: a delta can end between the two `$` of one
   * delimiter, and a repair decided on such a fragment frames the text differently than
   * one decided on the whole. So text is buffered until the release rule says it is safe,
   * and only then repaired.
   */
  let pending = ''
  /**
   * Raw text already folded into the repair.
   *
   * Repairs are NOT compositional — `repair("a $b")` is not a prefix of
   * `repair("a ") + repair("$b")`, because the trailing fragment opens a region the
   * earlier one closed. So a release is never repaired on its own: every settle repairs
   * `rawFolded + pending` as a single unit and emits only what is new. Cumulative repair
   * is what makes the emitted output a monotone prefix extension.
   */
  let rawFolded = ''
  /** The repair of `rawFolded`. */
  let repaired = ''
  /** How much of `repaired` has been emitted. */
  let sentOut = 0
  /** True once the marker has been seen, so it must be stripped from output. */
  let stripping = false

  /**
   * Repair a settled stretch of text.
   *
   * Text with no delimiter and no backslash cannot hold a region, so it passes through
   * byte-identically — which is also what keeps a plain prose prefix untouched.
   */
  function repairWhole(text) {
    if (text.length === 0) return ''
    const clean = stripping ? text.split(TOKEN).join('') : text
    if (clean.length === 0) return ''
    if (repairMode === 'off') return clean
    if (!clean.includes('$') && !clean.includes('\\')) return clean
    let result
    try {
      result = repairText(clean)
    } catch (err) {
      // A guard that breaks a turn is worse than the defect it prevents.
      log(`repair failed, passing text through: ${err?.message ?? err}`)
      return clean
    }
    if (result.repairs.length > 0) {
      const reasons = result.repairs.map((r) => r.reason).join(', ')
      if (repairMode === 'check-only') {
        log(`would repair ${result.repairs.length} region(s): ${reasons}`)
        return clean
      }
      log(`repaired ${result.repairs.length} region(s): ${reasons}`)
    }
    return result.text
  }

  /**
   * Fold every character received so far into the repair, returning the new output.
   *
   * The repair must extend what was already emitted. When it does not — a repair that
   * reached backwards into emitted text — the safe move is to emit nothing and keep the
   * text buffered, because the alternative is output the final answer would contradict.
   */
  function settle() {
    if (pending.length === 0) return ''
    const whole = rawFolded + pending
    const next = repairWhole(whole)
    if (debug) {
      console.error(
        `[dsh-math-tex] settle pending=${pending.length} whole=${whole.length} next=${next.length} ` +
          `repaired=${repaired.length} sentOut=${sentOut} stripping=${stripping}`,
      )
    }
    if (!next.startsWith(repaired) && repaired.length > 0) {
      log(`repair would rewrite emitted text; holding ${pending.length} chars for the next release`)
      return ''
    }
    // Only now is the slice part of the repair. When the repair is refused the slice
    // stays out of `rawFolded`, so the next release attempts it again with more context
    // instead of losing it.
    rawFolded = whole
    pending = ''
    const out = next.length > sentOut ? next.slice(sentOut) : ''
    repaired = next
    sentOut = next.length
    return out
  }

  return {
    /**
     * @param {string} text
     * @returns {string} text to emit for this delta (may be '')
     */
    push(text) {
      pending += text
      if (pending.includes(TOKEN)) {
        // The marker is one instruction among several, not an end marker: the answer
        // continues after it. Remove it and carry on with the normal release rule, so the
        // text that follows is released like any other.
        stripping = true
        pending = pending.split(TOKEN).join('')
      }
      if (pending.length <= tailBuffer) return ''
      const cut = safeCut(pending.slice(0, pending.length - tailBuffer))
      if (cut <= 0) return ''
      const delta = pending.slice(0, cut)
      const rest = pending.slice(cut)
      pending = delta
      const out = settle()
      // `settle` consumes the whole slice when it succeeds, and nothing when it refuses;
      // either way the unsettled remainder stays buffered.
      pending = pending + rest
      return out
    },

    /**
     * @returns {string} the tail, repaired. Call once, at block end.
     */
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
 * Only `text-delta` chunks are touched, and only their `text` field: the block index, the
 * delta order and every non-text chunk pass through untouched, so reasoning deltas, tool
 * calls and usage frames stay byte-identical.
 *
 * @param {AsyncIterable<{ type: string, index?: number, text?: string, blockType?: string }>} inner
 * @param {{ onLog?: (line: string) => void, maxHold?: number, tailBuffer?: number, repairMode?: 'auto' | 'check-only' | 'off', debug?: boolean }} [opts]
 * @returns {AsyncIterable<object>}
 */
export async function* guardStream(inner, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : onLog
  const states = new Map()
  let current = null
  let seen = 0
  let emitted = 0

  const stateFor = (index) => {
    let s = states.get(index)
    if (!s) {
      s = createBlockState({ ...opts, log })
      states.set(index, s)
    }
    return s
  }

  /**
   * Close the block whose text is still buffered, if any.
   * @param {number} index
   */
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

/**
 * Register both defences on a Cordis context.
 *
 * The loader stores the plugin's options in the context's `Config`, so the config is read
 * from there when present and from the plugin argument otherwise. Both defences are
 * best-effort and independent: a host without `systemPrompt` still gets the stream guard,
 * and a host whose configuration is rejected still gets both with defaults, because a
 * plugin that refuses to load is worse than one running with a safe default.
 *
 * Asynchronous because the renderer is loaded before the first turn rather than during it:
 * resolving KaTeX is an `import`, and doing it lazily inside the stream would make the
 * first text delta wait on I/O — the one place in this plugin that must never block.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [inline] config passed directly (tests, or a manual mount)
 * @returns {Promise<void>}
 */
export async function apply(ctx, inline) {
  // Which config wins: an explicit argument, then the loader-managed Config service, then
  // this plugin's declared defaults.
  let raw = inline
  if (raw === undefined) {
    try {
      raw = ctx?.get?.('Config')?.get?.('dsh-math-tex')
    } catch {
      raw = undefined
    }
  }
  const { config, errors } = resolveConfig(raw)
  active = config

  const sinks = []
  if (config.logFile) sinks.push((line) => appendLog(config.logFile, line))
  try {
    const logger = ctx?.get?.('logger')
    if (logger && typeof logger.info === 'function') sinks.push((line) => logger.info(line))
  } catch {
    // Keeping the file sink is better than failing the plugin tree.
  }
  setLogger((line) => {
    for (const sink of sinks) {
      try {
        sink(line)
      } catch {
        // A logging sink must never be able to break a turn.
      }
    }
  })
  const log = (line) => onLog(line)

  for (const message of errors) log(`config: ${message}`)
  if (!config.enabled) {
    log(`disabled by config (BUILD=${BUILD}); neither defence is mounted`)
    return
  }

  // Point the oracle at the same renderer build the client uses, then load it once, here,
  // while nothing is streaming. The default resolution already finds the shipped build;
  // `hostDir` only matters when the resolution walk cannot reach the profile's tree.
  const dshHome = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
  setOracleOptions({
    katexPath: config.katexPath,
    macros: config.macros,
    hostDir: `${dshHome.replace(/[\\/]+$/, '')}/profiles/desktop`,
  })
  const oracle = await loadOracle()
  log(oracle.available ? `oracle: katex ${oracle.version}` : `oracle unavailable: ${oracle.error}`)

  // 1. Pre-emptive prompt rules.
  const rules = config.promptRules === 'off' ? null : PROMPT_RULES[config.promptRules]
  if (rules) {
    try {
      const sp = ctx.get('systemPrompt')
      if (sp && typeof sp.section === 'function') {
        sp.section({ name: 'math-output-format', order: 1000, interpolate: false, text: rules.join('\n') })
        log(`prompt section "math-output-format" registered (${config.promptRules})`)
      } else {
        log('systemPrompt.section unavailable; prompt rules skipped')
      }
    } catch (err) {
      log(`prompt section failed: ${err?.message ?? err}`)
    }
  } else {
    log('prompt rules disabled by config')
  }

  // 2. The pre-persistence backstop.
  try {
    ctx.on('llm/stream', (options, next) => {
      log(`llm/stream hooked model=${options?.model ?? '?'} mode=${config.repair}`)
      return guardStream(next(), {
        onLog: log,
        maxHold: config.maxHold,
        tailBuffer: config.tailBuffer,
        repairMode: config.repair,
      })
    })
    log(`listener registered (BUILD=${BUILD})`)
  } catch (err) {
    log(`llm/stream hook failed: ${err?.message ?? err}`)
  }
}

export const name = 'dsh-math-tex'
export const inject = []
