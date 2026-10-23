# dsh-math-tex

Keeps DSH maths answers readable: prompt rules for the model, plus a guard that repairs any
formula region the renderer would paint red — before the text is persisted.

Host-side only. There is no client half, because the renderer cannot be changed and the last
moment the text is still ours is the stream.

---

## The problem

DSH renders Markdown maths with KaTeX and, on anything it cannot parse, dumps the **raw
source** in KaTeX's error colour `#cc0000`. **There is no crash and no logged error**: one
badly placed `$$` is enough to turn a whole derivation into what the user described as "一片
血红" — a wall of red, with no indication of which part failed or why.

The frontend is a single bundled file inside `app.asar` and passes no KaTeX options at all
(no `errorColor`, no `maxExpand`, no `trust`), so this cannot be configured after the fact.
Once the text is persisted, both the screen and the session record are wrong.

`dsh-math-tex` therefore works on the text before it is persisted.

## Two defences

| | Mechanism | What it does |
| --- | --- | --- |
| 1 | `systemPrompt.section` | Pre-emptive rules: a display block on its own paragraph, nothing but maths inside `$$`, no heading glued to a formula. By default they reach only a session that already carries maths (`promptRules: auto`) |
| 2 | `llm/stream` waterfall | The backstop: judges every region with the **same KaTeX build the client uses** and rewrites the ones that would render red, before they are written |

Defence 2 is the point. `llm/stream` wraps every streaming model call, and a rewritten chunk
reaches the durable message body, the live client frames and later compaction alike — so the
screen and the record are repaired together.

It reads **two delimiter syntaxes**: `$…$` / `$$…$$` and LaTeX's own `\(…\)` / `\[…\]`. The
second is not optional. In one session on 2026-10-18 the model wrote 11 883 characters of
answers containing 205 backslash formulas and **zero** `$`, and the surface rendered them as
formulas anyway — a guard that knows one syntax protects half the answers.

## Detection asks the renderer, not a regex

The intuitive heuristics are wrong in **both** directions: a 300-character formula, an
8-deep `\underbrace`, `\substack` and Chinese inside maths all render fine, while a
99-character formula died.

"Did the renderer throw?" is not the criterion either:

| Input | Arm 1 (strict) | Arm 2 (lenient) | What the reader sees |
| --- | --- | --- | --- |
| `\foobar{x}` | throws | does not throw — paints `\foobar` in `#cc0000` | red |
| `x_1_2` (double subscript) | throws | does not throw | red |
| `\htmlClass{red}{x}` | **succeeds** | — | **red** |

The third row is the nasty one: the strict call succeeds and the output still carries the
error colour, so an exception-based oracle calls it healthy. The verdict is therefore taken
from the **rendered output**.

## Repair never guesses at mathematics

When a region would render red, in order:

1. **Re-frame** — the formula is fine and only its framing is wrong (a `$$` opened
   mid-paragraph), so it becomes a proper `$$\n…\n$$` block;
2. **Neutralise, only where the meaning is certain** — strip the backslash from a command the
   renderer cannot use (`\foobar` → `foobar`), or regroup a doubled operator
   (`x_1_2` → `x_{1_2}`). A candidate is accepted only if it re-renders with **no red and a
   passing strict call**, so a change that merely moves the error can never loop;
3. **Degrade the source** — damage that cannot be repaired (an unclosed brace, `\begin`
   without `\end`) is shown as source: a fenced block for a display region, and for an
   inline one just the delimiters removed (a fence is multi-line, so using it inline once
   carved a table row into three pieces).

**Mathematics is never deleted.** The worst case shows the reader the formula source —
recoverable and copyable — instead of red text. Guessing at structural damage would invent
mathematics the author never wrote, and that is not done.

## Install

```bash
node tools/install.mjs              # copy into the profile and register the bundle
node tools/install.mjs --dry-run    # report what would change
node tools/install.mjs --uninstall  # take it out of the bundle list
```

A **new session** is required afterwards: the bundle stack is read when a session's runner
process starts, so the current session will not pick it up.

To mount it by hand, put this package under `<profile>/node_modules/` and add its name to
`dsh.profile.bundles` in the profile's `package.json`.

## Configuration

Set options by id from the profile's `cordis.patch.yml`:

```yaml
- id: dsh-math-tex
  name: dsh-math-tex
  config:
    repair: auto
    logFile: C:/tmp/math-tex.log
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` mounts neither defence |
| `promptRules` | `auto` | `auto` injects only into a session that already carries math / `full` injects all nine rules everywhere / `minimal` keeps just the two that prevent red / `off` injects nothing |
| `repair` | `auto` | `auto` rewrites; `check-only` logs without rewriting; `off` passes everything |
| `tailBuffer` | `15` | Smallest suffix held back, so a completion marker cannot leak character by character |
| `maxHold` | `600` | Longest a single unclosed region may wait; past it the block is released unrepaired and stays unrepaired to its end (better to do nothing than to stall) |
| `logFile` | `''` | Diagnostic log path; empty means the host logger only |
| `katexPath` | `''` | Pin the renderer; by default it is resolved from the profile |
| `macros` | `{}` | Macros handed to the renderer, to match the client's behaviour |

An unknown key is an **error, not a silent no-op** — a misspelled option that looks like it
worked is worse than no option at all.

## The log proves it is running

```
oracle: katex 0.16.47
prompt section "math-output-format" registered (auto)
llm/stream hooked model=deepseek-flash mode=auto
guarded stream: 214 text delta(s) in, 231 out
```

The last line is the evidence of a **real** turn: `in` must be well above 1 (a self-test fake
stream has exactly 1).

## Tests

```bash
npm test
```

| File | What it measures | Assertions |
| --- | --- | --- |
| `guard-test` | does the judge agree with the renderer; are both delimiter syntaxes (`$…$` and `\(…\)`) understood; does a repair leave the surrounding Markdown intact; can a release land inside an unclosed code span, or be fooled by a fence that started earlier; is raw HTML reported (never rewritten), even when the tag is split across releases? | 106 |
| `red-render-test` | are all three red classes caught; do `$$` fences sit on lines of their own (the only shape the host closes); is the echo read from the right account? | 87 |
| `e2e-test` | does the real incident come out readable end to end? | 39 |
| `wire-test` | does the streamed output equal the whole-text repair, and is the text on `block-end` the repaired one too? | 116 |
| `fuzz-test` | does that hold under 236 arbitrary chunkings? | 236 |
| `config-test` | does every documented option actually do something? | 36 |
| `smoke-test` | does the package load the way the host loads it? | 23 |
| `installed-test` | can the **installed copy** in the profile (not the source tree) load and repair; is it byte-identical to the source? | 12 |
| `regression-test` | do fixed defects stay fixed? (cases quoted verbatim from real sessions) | 23 |
| `live-path-test` | **acceptance**: installed copy + the profile's real config + the host's mount path — does a broken answer actually become clean text? | 28 |

706 assertions across 10 files, about 4 seconds, no network.

`fuzz-test` is the strongest instrument: it requires **any** chunking of the real incident —
one character per frame up to 1600, plus random splittings — to reassemble byte-identically
to the single-pass repair.

`live-path-test` is the only file that joins the installed copy, the profile's configuration,
the host's mount path and a real delta stream into one measurement. Every case runs twice: with
the repairer off the defect must reach the reader unchanged, with it on the same defect must
disappear — the first arm is what makes the second one mean anything, since a case that was
never broken would otherwise "pass".

`regression-test` is the only file whose assertion is about the **emitted text** rendering
without red; the others check the judge and the region structure. It is the last line of
defence against "the verdict was right but the rewrite is still red". Revert the fix and it
fails 4 assertions.

## Inspecting a real session

```bash
node tools/find-red-session.mjs                   # every session, listing answers that would render red
node tools/strip-sentinel.mjs --list              # records still holding the completion marker
node tools/strip-sentinel.mjs --id <prefix> --yes # strip it (frame-wise, self-verifying, rolls back on any mismatch)
node tools/inspect-session.mjs <session.jsonl>    # one session, message by message: regions, verdicts, what the guard would do
node tools/probe-region.mjs 'd\alpha=0'           # push candidate spellings through the renderer one by one
```

A record holds the **pre-repair** text: the guard rewrites the outgoing stream, not the model's
message. So "the record still has a broken formula" does not mean the screen did — judge the
exit of the same stream instead. `tools/find-red-session.mjs` reports verdicts on the recorded
text, which is why a flagged region there is evidence about the model, not about the reader.

## Design boundaries

- **The renderer cannot be patched.** That is the premise, not a compromise: the frontend is
  a built bundle with no maths-related slot to replace.
- **Host side only.** `llm/stream` is the only interception point that reaches the screen,
  the session record and compaction at once.
- **Do nothing rather than stall.** Every wait is bounded by `maxHold`; past it the text is
  released unrepaired, which is exactly the unguarded behaviour and therefore safe.
- **Non-mathematical text is untouched**, byte for byte.

## Documentation

- `STATUS.md` — what is installed, what has been proven, what has not (handover).
- `docs/` — where the criteria come from: `FINDINGS.md` (what actually breaks),
  `KATEX-MEASUREMENTS.md` (per-case numbers), `DESIGN.md` (how the design was chosen and what
  was rejected).

## License

MIT
