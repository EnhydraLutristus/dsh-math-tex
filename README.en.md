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
| 1 | `systemPrompt.section` | Pre-emptive rules: a display block on its own paragraph, nothing but maths inside `$$`, no heading glued to a formula |
| 2 | `llm/stream` waterfall | The backstop: judges every region with the **same KaTeX build the client uses** and rewrites the ones that would render red, before they are written |

Defence 2 is the point. `llm/stream` wraps every streaming model call, and a rewritten chunk
reaches the durable message body, the live client frames and later compaction alike — so the
screen and the record are repaired together.

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
3. **Fence the source** — damage that cannot be repaired (an unclosed brace, `\begin`
   without `\end`) is shown as a fenced block.

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
| `promptRules` | `full` | `full` / `minimal` / `off` — how much of the rule set is injected |
| `repair` | `auto` | `auto` rewrites; `check-only` logs without rewriting; `off` passes everything |
| `tailBuffer` | `15` | Smallest suffix held back, so a completion marker cannot leak character by character |
| `maxHold` | `600` | Longest a single unclosed region may wait; past it the text is released unrepaired (better to do nothing than to stall) |
| `logFile` | `''` | Diagnostic log path; empty means the host logger only |
| `katexPath` | `''` | Pin the renderer; by default it is resolved from the profile |
| `macros` | `{}` | Macros handed to the renderer, to match the client's behaviour |

An unknown key is an **error, not a silent no-op** — a misspelled option that looks like it
worked is worse than no option at all.

## The log proves it is running

```
oracle: katex 0.16.47
prompt section "math-output-format" registered (full)
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
| `guard-test` | does the judge agree with the renderer about regions? | 39 |
| `red-render-test` | are all three red classes caught? | 48 |
| `e2e-test` | does the real incident come out readable end to end? | 39 |
| `wire-test` | does the streamed output equal the whole-text repair? | 97 |
| `fuzz-test` | does that hold under 236 arbitrary chunkings? | 236 |
| `config-test` | does every documented option actually do something? | 26 |
| `smoke-test` | does the package load the way the host loads it? | 22 |
| `installed-test` | can the **installed copy** in the profile (not the source tree) load and repair? | 10 |
| `regression-test` | do fixed defects stay fixed? (cases quoted verbatim from real sessions) | 23 |

540 assertions across 9 files, about 4 seconds, no network.

`fuzz-test` is the strongest instrument: it requires **any** chunking of the real incident —
one character per frame up to 1600, plus random splittings — to reassemble byte-identically
to the single-pass repair.

`regression-test` is the only file whose assertion is about the **emitted text** rendering
without red; the others check the judge and the region structure. It is the last line of
defence against "the verdict was right but the rewrite is still red". Revert the fix and it
fails 4 assertions.

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
