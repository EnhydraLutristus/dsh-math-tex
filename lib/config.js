/**
 * dsh-math-tex — configuration contract.
 *
 * The plugin's options are declared twice on purpose, because the two declarations are
 * read by different consumers:
 *
 * - `ConfigSchema` is plain JSON Schema — the readable description of every option, and
 *   what this module's own validator mirrors.
 * - `Config` is the Cordis plugin field the LOADER reads, and it must be a native
 *   Schemastery schema. This is not a style preference: cordis resolves an entry's config
 *   through `resolveConfig(runtime, config)`, which does
 *   `runtime.Config['~standard'].validate(config)` (cordis `lib/index.js:956-962`). A plain
 *   object has no `~standard`, so that line throws `TypeError: Cannot read properties of
 *   undefined (reading 'validate')` inside the fiber's `_reload()`, which catches it, stores
 *   it, and marks the fiber FAILED. The measured symptom was a plugin listed as
 *   "异常/failed" whose `apply` was never called at all — for months of restarts.
 *
 * Every default is the behaviour the plugin was measured with, so an empty config
 * reproduces the tested build exactly.
 *
 * @module config
 */

import { createRequire } from 'node:module'

/** Defaults, kept beside the schema so the two cannot drift apart silently. */
export const DEFAULTS = {
  enabled: true,
  promptRules: 'auto',
  repair: 'auto',
  tailBuffer: 15,
  maxHold: 600,
  logFile: '',
  katexPath: '',
  macros: {},
}

/**
 * Descriptions, kept in one place so the JSON Schema and the Schemastery schema cannot
 * drift. Same wording in both, because the host shows one and the docs quote the other.
 */
const DESCRIPTION = {
  enabled: 'Mount both defences. When false the plugin loads and does nothing.',
  promptRules:
    'Prompt section injected before each model step. "auto" (the default) contributes the ' +
    'rules only to a session that has already carried mathematics, so a session that never ' +
    'typesets anything is not asked for formulae; the decision is sticky for the life of the ' +
    'session, which keeps the prompt a stable cache prefix. "full" contributes the seven ' +
    'measured rules to every session; "minimal" keeps only the two that prevent the reported ' +
    'failure (display maths on its own paragraph, no Markdown inside a `$$` block); "off" adds ' +
    'no prompt text at all. The stream guard runs in every mode.',
  repair:
    '"auto" rewrites a region the renderer would paint red; "check-only" logs what it would ' +
    'have repaired and changes nothing (useful for judging the guard before trusting it); ' +
    '"off" passes the stream through untouched.',
  tailBuffer:
    'Characters withheld at the tail of the stream. Must be at least the length of the ' +
    'completion marker minus one, otherwise a marker split across two deltas leaks into the ' +
    'answer. Raise it only if a longer marker is configured.',
  maxHold:
    'How many characters may be held while an unclosed math region waits. Past this the text ' +
    'is released unrepaired rather than stalling the visible answer, so a `$$` that never ' +
    'closes degrades to the unguarded behaviour instead of hanging.',
  logFile:
    'Where to append the guard log. Empty disables the file sink. The session runner has no ' +
    'log of its own, so this file is the only record that a live turn was guarded — set it ' +
    'to an absolute path when diagnosing.',
  katexPath:
    'Directory holding the KaTeX build to judge with. Empty resolves `katex` from the host ' +
    'profile, which is where the renderer gets it. Set it explicitly only to pin a different ' +
    'build for comparison.',
  macros:
    'Extra KaTeX macros, `\\name` → expansion, used when judging. They must match what the ' +
    'renderer uses or a region judged healthy could still fail on screen.',
}

/**
 * Locate Schemastery the way the loader will.
 *
 * Anchored at this module's own URL, so resolution walks `<plugin>/node_modules`, then the
 * directory the plugin is installed into — `<profile>/node_modules`, where the host keeps
 * Schemastery for exactly this purpose. Other host entry points are the fallback for a host
 * that puts it somewhere else.
 *
 * A missing copy is survivable but degraded: without it there is no exportable `Config`, so
 * the plugin cannot be listed in the config inventory. The plugin still mounts, because the
 * loader passes the profile's `config:` block to `apply` directly — a far better outcome
 * than a fiber that cannot start.
 */
function loadSchemastery() {
  const require = createRequire(import.meta.url)
  for (const specifier of [
    '@deepseek-ai/schemastery',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis',
  ]) {
    try {
      const mod = require(specifier)
      const schema = mod?.default ?? mod?.Schema ?? mod
      if (typeof schema === 'function' && typeof schema.object === 'function') return schema
    } catch {
      // try the next one; a missing optional dependency is not an error worth throwing
    }
  }
  return undefined
}

const Schema = loadSchemastery()

/**
 * The option schema as the loader wants it: a native Schemastery schema built from the same
 * `DEFAULTS` and descriptions as the JSON Schema below. `undefined` when the host has no
 * Schemastery, in which case nothing is exported as `Config` — see `loadSchemastery`.
 *
 * The host's option schema is NOT this schema: this one refuses nothing, so the checks in
 * `resolveConfig` below (unknown keys included) are still the ones that decide what the
 * plugin runs with.
 */
function buildConfig() {
  if (!Schema) return undefined
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled).description(DESCRIPTION.enabled),
    promptRules: Schema.union(['auto', 'full', 'minimal', 'off'])
      .default(DEFAULTS.promptRules)
      .description(DESCRIPTION.promptRules),
    repair: Schema.union(['auto', 'check-only', 'off'])
      .default(DEFAULTS.repair)
      .description(DESCRIPTION.repair),
    tailBuffer: Schema.number()
      .min(0)
      .max(4096)
      .default(DEFAULTS.tailBuffer)
      .description(DESCRIPTION.tailBuffer),
    maxHold: Schema.number().min(0).default(DEFAULTS.maxHold).description(DESCRIPTION.maxHold),
    logFile: Schema.string().default(DEFAULTS.logFile).description(DESCRIPTION.logFile),
    katexPath: Schema.string().default(DEFAULTS.katexPath).description(DESCRIPTION.katexPath),
    macros: Schema.dict(Schema.string()).default(DEFAULTS.macros).description(DESCRIPTION.macros),
  })
}

/**
 * The option schema as data — plain JSON Schema, and the shape this module's own validator
 * checks. Kept for readers and for tooling that wants the description without a schema
 * library; the loader reads `Config` instead.
 *
 * `additionalProperties: false` is deliberate: a typo in `cordis.patch.yml` is then a
 * visible validation error instead of a silently ignored setting, which is how people end
 * up believing they configured something they did not.
 */
export const ConfigSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: {
      type: 'boolean',
      default: true,
      description: 'Mount both defences. When false the plugin loads and does nothing.',
    },
    promptRules: {
      enum: ['auto', 'full', 'minimal', 'off'],
      default: 'auto',
      description:
        'Prompt section injected before each model step. "auto" (the default) contributes the ' +
        'rules only to a session that has already carried mathematics, so a session that never ' +
        'typesets anything is not asked for formulae; the decision is sticky for the life of the ' +
        'session, which keeps the prompt a stable cache prefix. "full" contributes the seven ' +
        'measured rules to every session; "minimal" keeps only the two that prevent the reported ' +
        'failure (display maths on its own paragraph, no Markdown inside a `$$` block); "off" adds ' +
        'no prompt text at all. The stream guard runs in every mode.',
    },
    repair: {
      enum: ['auto', 'check-only', 'off'],
      default: 'auto',
      description:
        '"auto" rewrites a region the renderer would paint red; "check-only" logs what it would ' +
        'have repaired and changes nothing (useful for judging the guard before trusting it); ' +
        '"off" passes the stream through untouched.',
    },
    tailBuffer: {
      type: 'integer',
      minimum: 0,
      maximum: 4096,
      default: 15,
      description:
        'Characters withheld at the tail of the stream. Must be at least the length of the ' +
        'completion marker minus one, otherwise a marker split across two deltas leaks into the ' +
        'answer. Raise it only if a longer marker is configured.',
    },
    maxHold: {
      type: 'integer',
      minimum: 0,
      default: 600,
      description:
        'How many characters may be held while an unclosed math region waits. Past this the text ' +
        'is released unrepaired rather than stalling the visible answer, so a `$$` that never ' +
        'closes degrades to the unguarded behaviour instead of hanging.',
    },
    logFile: {
      type: 'string',
      default: '',
      description:
        'Where to append the guard log. Empty disables the file sink. The session runner has no ' +
        'log of its own, so this file is the only record that a live turn was guarded — set it ' +
        'to an absolute path when diagnosing.',
    },
    katexPath: {
      type: 'string',
      default: '',
      description:
        'Directory holding the KaTeX build to judge with. Empty resolves `katex` from the host ' +
        'profile, which is where the renderer gets it. Set it explicitly only to pin a different ' +
        'build for comparison.',
    },
    macros: {
      type: 'object',
      default: {},
      description:
        'Extra KaTeX macros, `\\name` → expansion, used when judging. They must match what the ' +
        'renderer uses or a region judged healthy could still fail on screen.',
      additionalProperties: {
        type: 'string',
      },
    },
  },
}

/**
 * Validate and normalise a config object.
 *
 * Written by hand rather than pulled from a schema library on purpose: the plugin must
 * load in a host whose dependency tree it does not control, and a validation dependency
 * that fails to resolve would take the whole plugin (and therefore the boot) with it.
 * The checks below cover the contract the code actually relies on.
 *
 * Unknown keys are rejected, and a `null` value is read as "not set" so an explicit
 * `null` in YAML does not become a type error.
 *
 * @param {Record<string, unknown> | undefined | null} input
 * @returns {{ config: typeof DEFAULTS, errors: string[] }}
 */
export function resolveConfig(input) {
  const errors = []
  const config = { ...DEFAULTS }
  if (input === undefined || input === null) return { config, errors }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { config, errors: [`config must be an object, got ${Array.isArray(input) ? 'array' : typeof input}`] }
  }

  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push(`unknown option ${JSON.stringify(key)} (ignored)`)
  }

  const take = (key, test, describe) => {
    const value = input[key]
    if (value === undefined || value === null) return
    if (test(value)) config[key] = value
    else errors.push(`${key} ${describe}, got ${JSON.stringify(value)}`)
  }

  take('enabled', (v) => typeof v === 'boolean', 'must be a boolean')
  take('promptRules', (v) => ['auto', 'full', 'minimal', 'off'].includes(v), 'must be auto | full | minimal | off')
  take('repair', (v) => ['auto', 'check-only', 'off'].includes(v), 'must be auto | check-only | off')
  take('tailBuffer', (v) => Number.isInteger(v) && v >= 0 && v <= 4096, 'must be an integer in 0..4096')
  take('maxHold', (v) => Number.isInteger(v) && v >= 0, 'must be a non-negative integer')
  take('logFile', (v) => typeof v === 'string', 'must be a string path')
  take('katexPath', (v) => typeof v === 'string', 'must be a string path')
  take(
    'macros',
    (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'),
    'must be an object of string expansions',
  )

  return { config, errors }
}

/**
 * The Cordis plugin field: the native Schemastery schema the loader validates a user's
 * `config:` block against, and the schema the host lists in its config inventory.
 *
 * `undefined` is a legitimate value here — it means the host had no Schemastery to build it
 * with. The loader reads it as "this plugin declares no options schema", which is true, and
 * still hands the profile's `config:` block to `apply` as that function's second argument.
 */
export const Config = buildConfig()
