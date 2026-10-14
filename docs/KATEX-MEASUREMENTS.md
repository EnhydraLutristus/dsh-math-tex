# KaTeX measurement — what actually breaks, and what does not

> **Historical** — measured during the reconnaissance phase, before the guard existed; it is
> the numeric basis for `lib/tex-repair.js` (every threshold below has a test behind it).
> Current state and test inventory: `STATUS.md` in the repository root.

Everything below was measured against **KaTeX 0.16.47**, the exact version the product pins
(`dsh-client-ui-primitives` → `katex ^0.16.47`, inlined into `vendor-CCJJTK99.js`). The local copy in
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\katex` is the same version, so the measurements
apply to the shipped renderer.

Each case was pushed through the product's own two-arm chain, not through a guess at it:

```
tier 1  renderToString(value, { displayMode, throwOnError: true })
tier 2  renderToString(value, { displayMode, strict: 'ignore', throwOnError: false })
tier 3  (product only) a red .katex-error span containing the raw source
```

Scripts: `katex-ab.mjs` → `katex-ab-results.json` (31 cases), `oracle-check.mjs` (the real block),
`cjk-markup.mjs`, `prose-in-math.mjs`, `cjk-css-scan.mjs`.

## 1. The fault is exactly a delimiter collision, not "complexity"

The single most useful measurement is the direct one — the user's actual block, reconstructed from the
screenshot as one `$$` region that swallowed prose and a heading:

```
verdict  T1-FAIL -> tier 2 error span (tier 3)
message  KaTeX parse error: Can't use function '$' in math mode at position 99:
         …_{\text{左行波 }G}$$ 初始鼓包被劈成两半，每半高…
```

Read that error text closely, because it names the mechanism: the `$$` that the **model** intended as the
closing delimiter was consumed as mathematics (`\text{左行波 }G` then `$` is parsed as a math-mode
command), so the *next* `$` — the one opening `$1/2$` in the following sentence — becomes the character
KaTeX chokes on. The delimiters are paired one-off from that point onward.

This settles two things that had been assumed:

- the failure is **positional, not size-related**. A 99-character formula fails; a 300-character legal
  formula passes. Nothing about "the LaTeX was too complex" is true of the observed incident.
- the failure is **deterministic and host-reproducible**. No browser, no DOM, no guessing: one call to
  the pinned KaTeX returns the same verdict the renderer reached.

And the same content, with only the structural faults removed, renders clean:

| fragment | verdict |
| --- | --- |
| the d'Alembert formula alone | PASS (strict), 0 warnings |
| the inline `1/2` | PASS (strict), 0 warnings |
| the boundary condition `u(0,t)=0` | PASS (strict), 0 warnings |

So the mathematics was never the problem. The packaging of the mathematics was.

## 2. Not all the suspected triggers are real

31 cases through the real chain. The results contradict several intuitive rules, which is the reason for
measuring rather than pattern-matching:

| input | intuition | measured |
| --- | --- | --- |
| prose inside `$$` (CJK, no markdown chars) | breaks | **tier 1 — renders fine** |
| `**bold**` inside maths | breaks | **tier 1 — renders fine** |
| Chinese inside `\text{}` | risky | tier 1, 0 warnings — the correct form |
| bare Chinese in maths | risky | tier 1, 0 warnings, emits `mord cjk_fallback` |
| long 200+ char formula | risky | **tier 1 — renders fine** |
| 8-deep nested `\underbrace` | risky | **tier 1 — renders fine** |
| `\substack`, `\begin{cases}`, deep `\frac` nesting | risky | tier 1 — renders fine |
| `##` inside maths | — | **tier 3 red dump** — `Expected 'EOF', got '#'` |
| stray `$` or `$$` inside maths | — | **tier 3 red dump** — `Can't use function '$'` |
| `x_1_2` (double subscript) | — | **tier 3 red dump** |
| unclosed `{`, unclosed `\left`, stray `&`, `\begin` without `\end` | — | **tier 3 red dump** |

Group summary: the four markdown-in-math cases split 2 broken / 2 fine; every TeX-syntax fault broke;
every size/complexity case passed; every control case passed.

**Consequence for the design:** a rule based on length, brace depth, "heavy constructs" or density —
i.e. the classifier built in the earlier risk-scoring probe — is aimed at inputs KaTeX accepts. What
actually has to be caught is a small, enumerable set of structural faults.

## 3. Correction: prose in maths is not corrupted, and the warning is not a detector

An intermediate reading of the A/B run suggested that prose swallowed into maths is silently typeset as
italic variables, and that KaTeX's `strict` warnings could therefore serve as an oracle for natural
language inside maths. Inspecting the produced markup refutes both halves:

`u = x + 初始鼓包` renders the Chinese inside `<mtext>初始鼓包</mtext>` with `class="mord cjk_fallback"`,
which is the **same markup** `\text{初始鼓包}` produces. KaTeX detects CJK and routes it through its
text-fallback path automatically. The `[unicodeTextInMathMode]` warning is emitted, but the output is
correct.

So: bare CJK in maths is a supported input, not a defect. Any repair rule that rewrites CJK would fight
the renderer's own behaviour. The warning stream is not a usable detector and was dropped.

(Side note, cosmetic only: `cjk_fallback` appears in **zero** of the 132 shipped web-frontend assets —
KaTeX emits the class but the product ships no rule for it, so CJK inside maths inherits the surrounding
font. Minor, unrelated to this failure.)

## 4. The detection strategy this implies

Since the pinned KaTeX is available to the host, the guard should not approximate the renderer — it
should **ask it**:

1. For each math region in the assembled text, call `renderToString` with the product's exact tier-1
   options. This is a pure function, already proven to reproduce the failure and to pass the repaired
   version.
2. On failure, take the error's *position* (KaTeX reports it: `at position 99`) and reclassify that region
   as source text rather than maths — which is precisely the repair that makes all three fragments pass.
3. Retry once; if it still fails, leave the block as fenced plain text rather than emitting something the
   renderer will paint red.

Two properties make this worth preferring over a hand-written regex classifier: it cannot drift from the
renderer (same library, same version, same options), and it produces no false positives on the 15 legal
cases above, including the long and deeply nested ones a regex rule would flag.

## 5. Limits of these measurements

- They cover the renderer's behaviour, not the streaming path. DSH renders fenced `math` blocks only when
  `!context.streaming` (`primitives.js:11356`), while `$…$` and `$$…$$` are rendered during streaming too.
  Whether a delimiter collision can occur *mid-stream* and resolve by itself was not measured.
- Only the two arms the product actually calls were exercised. A third-party `\htmlClass`-style escape
  cannot execute (`trust` is never set, so it defaults to false), but that was read from code, not tested.
- The reproduced block is a reconstruction from the screenshot, not the byte-exact message. The error
  position (99) therefore describes the reconstruction; the mechanism it names is what transfers.
