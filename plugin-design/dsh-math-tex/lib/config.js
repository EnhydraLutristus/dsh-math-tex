/**
 * dsh-math-tex — configuration contract.
 *
 * The plugin's options are declared as a JSON Schema so the host can validate them,
 * show them in the Settings → Plugins inventory, and let a user change them from
 * `cordis.patch.yml` without touching code. Both forms are exported because they play
 * different roles: `ConfigSchema` is data (what a user edits), and `Config` is the
 * Cordis plugin field the loader reads.
 *
 * Every default is the behaviour the plugin was measured with, so an empty config
 * reproduces the tested build exactly.
 *
 * @module config
 */

/** Defaults, kept beside the schema so the two cannot drift apart silently. */
export const DEFAULTS = {
  enabled: true,
  promptRules: 'full',
  repair: 'auto',
  tailBuffer: 15,
  maxHold: 600,
  logFile: '',
  katexPath: '',
  macros: {},
}

/**
 * The option schema.
 *
 * `additionalProperties: false` is deliberate: a typo in `cordis.patch.yml` is then a
 * visible validation error instead of a silently ignored setting, which is how people
 * end up believing they configured something they did not.
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
      enum: ['full', 'minimal', 'off'],
      default: 'full',
      description:
        'Prompt section injected before each model step. "full" is the seven measured rules; ' +
        '"minimal" keeps only the two that prevent the reported failure (display maths on its own ' +
        'paragraph, no Markdown inside a `$$` block); "off" adds no prompt text — the stream guard ' +
        'still runs.',
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
  take('promptRules', (v) => ['full', 'minimal', 'off'].includes(v), 'must be full | minimal | off')
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
 * The Cordis plugin field. The loader reads this export, projects it into the live
 * Config directory, and validates a user's `config:` block against it.
 */
export const Config = ConfigSchema
