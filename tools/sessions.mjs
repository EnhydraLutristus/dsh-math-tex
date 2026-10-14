/**
 * Where the host keeps its session records — worked out at run time, never hard-coded.
 *
 * The layout is:
 *
 *   <dsh home>/sessions/<workspace slug>/<session id>/session.v4.jsonl.zstd
 *
 * The workspace slug is the absolute path of the workspace with every character that is not
 * [A-Za-z0-9] replaced by `-` and the result wrapped in `--`. That transformation is lossy, so
 * the slug cannot be rebuilt from a path: `C:\a\b-c` and `C:\a\b\c` both come out as
 * `--C-a-b-c--`. Nothing here guesses. Callers that need "the sessions of this workspace" ask
 * for every session and let each caller filter on what it actually knows (the id, or the mtime).
 *
 * Reasoning about sessions of ONE workspace matters less than it looks: a session id is unique
 * across the whole machine, and "the newest session" is almost always the one the user just
 * finished. Being able to see all workspaces is strictly more useful than being pinned to the
 * one a developer happened to be in when the tool was written.
 */

import fs from 'node:fs'
import { join } from 'node:path'

/** The DSH home directory: the same precedence the plugin itself uses (lib/guard.js). */
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (!home) return ''
  return join(home, '.dsh')
}

/** The root that holds one directory per workspace slug. */
export function sessionsRoot() {
  const home = dshHome()
  return home ? join(home, 'sessions') : ''
}

/**
 * Every session record on this machine, newest first.
 *
 * Each entry: { file, dir, sessionId, workspace, mtimeMs }. A missing or empty sessions
 * directory yields [] — callers decide whether that is an error worth reporting; this function
 * never invents a directory to look in.
 */
export function listSessions({ maxDepth = 3 } = {}) {
  const root = sessionsRoot()
  const out = []
  if (!root || !fs.existsSync(root)) return out

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (e.name !== 'session.v4.jsonl.zstd') continue
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      // <root>/<workspace>/<session id>/session.v4.jsonl.zstd
      const sessionDir = join(full, '..')
      out.push({
        file: full,
        dir: sessionDir,
        sessionId: sessionDir.split(/[\\/]/).pop() ?? '',
        workspace: sessionDir.split(/[\\/]/).slice(-2, -1)[0] ?? '',
        mtimeMs: st.mtimeMs,
      })
    }
  }

  walk(root, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * One session record by id (a unique prefix is enough), or the newest one on the machine.
 * Returns null when nothing matches, so the caller can print its own message.
 */
export function findSession(id) {
  const all = listSessions()
  if (!id) return all[0] ?? null
  return all.find((s) => s.sessionId.includes(id)) ?? null
}
