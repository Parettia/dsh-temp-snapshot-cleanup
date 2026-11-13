/**
 * Filesystem side of the temp snapshot cleanup: find orphaned
 * `dsh-workspace-changes-<6>` directories under one root, measure them, and
 * remove one of them. Every decision here is deliberately conservative: a
 * directory this module cannot prove to be an inert, plain, old snapshot is
 * reported as skipped instead of removed.
 *
 * This module imports only Node builtins so it can be exercised outside the
 * Harness (see `README.md`, "Verification").
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Directory name produced by `@deepseek-ai/dsh-workspace-changes` (`mkdtemp` suffix: 6 chars). */
export const SNAPSHOT_NAME_PATTERN = /^dsh-workspace-changes-[A-Za-z0-9]{6}$/

/** Subdirectory that identifies a real snapshot: the git object store. */
export const SNAPSHOT_MARKER = 'objects'

/** A directory younger than this margin relative to Host start cannot belong to an earlier Host process. */
export const HOST_START_MARGIN_MS = 60_000

const HOUR_MS = 3_600_000

/** Upper bound on entries visited while measuring one directory, so a hostile tree cannot stall the Host. */
const MAX_SIZE_ENTRIES = 200_000

/**
 * Compare two absolute paths the way the platform does: Windows ignores case.
 * @param a - first absolute path.
 * @param b - second absolute path.
 * @returns true when both spell the same location.
 */
export function samePath(a, b) {
  const normalize = (value) => {
    const absolute = resolve(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return normalize(a) === normalize(b)
}

/**
 * Milliseconds since the epoch at which this process started.
 * @returns the start instant derived from `process.uptime()`.
 */
export function hostStartMs() {
  return Date.now() - process.uptime() * 1_000
}

/**
 * Resolve a directory only when it is a plain directory: symlinks, junctions,
 * and any other reparse point are refused, and the resolved target must be the
 * same location so a link cannot redirect the deletion elsewhere.
 * @param path - absolute candidate path.
 * @returns the lstat result, or null when the path is not a plain directory.
 */
async function plainDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) return null
  const target = await realpath(path)
  if (!samePath(target, path)) return null
  return info
}

/**
 * Timestamps that matter for judging age, in milliseconds since the epoch.
 *
 * Only creation, metadata-change, and last-write times count: the last-access
 * time is deliberately ignored, because merely listing a directory bumps it,
 * so a read-only report would otherwise keep pushing the candidates forward.
 * @param info - lstat result.
 * @returns the creation instant and the newest of the counted timestamps.
 */
export function timestampsOf(info) {
  const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined)
  const birth = finite(info.birthtimeMs)
  const created = birth ?? finite(info.ctimeMs) ?? info.mtimeMs
  const newest = Math.max(...[birth, finite(info.ctimeMs), finite(info.mtimeMs)].filter((value) => value !== undefined))
  return { created, newest }
}

/**
 * Total size of the regular files below a directory, without following links.
 * @param root - absolute directory path.
 * @returns summed bytes of every regular file reached, capped by {@link MAX_SIZE_ENTRIES}.
 */
export async function directorySize(root) {
  let total = 0
  let visited = 0
  const pending = [root]
  while (pending.length > 0 && visited < MAX_SIZE_ENTRIES) {
    const current = pending.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_SIZE_ENTRIES) break
      visited += 1
      const child = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await lstat(child)
        if (info.isFile()) total += info.size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

/**
 * Classify one entry of the temporary directory.
 * @param root - the temporary root the entry belongs to.
 * @param entry - a `readdir` entry with `isDirectory()`/`isSymbolicLink()`.
 * @param options - Host start, minimum age, and the instant used as "now".
 * @returns a candidate, or a skip record with the reason.
 */
async function classify(root, entry, options) {
  const path = join(root, entry.name)
  const { name } = entry
  if (!SNAPSHOT_NAME_PATTERN.test(name)) {
    // Only the snapshot tool's own prefix is worth a record; every other temp
    // child is counted and left alone.
    return name.startsWith('dsh-workspace-changes-') ? { skip: { path, name, reason: 'not-a-snapshot-name' } } : { ignored: true }
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return { skip: { path, name, reason: 'not-a-plain-directory' } }

  let info
  try {
    info = await plainDirectory(path)
  } catch (error) {
    return { skip: { path, name, reason: `unreadable:${error?.code ?? 'unknown'}` } }
  }
  if (info === null) return { skip: { path, name, reason: 'link-or-redirected' } }

  let marker
  try {
    marker = await lstat(join(path, SNAPSHOT_MARKER))
  } catch {
    return { skip: { path, name, reason: 'no-objects-directory' } }
  }
  if (!marker.isDirectory() || marker.isSymbolicLink()) return { skip: { path, name, reason: 'no-objects-directory' } }

  const { created, newest } = timestampsOf(info)
  if (newest >= options.hostStartMs - HOST_START_MARGIN_MS) {
    return { skip: { path, name, reason: 'touched-in-this-host-process' } }
  }
  const ageMs = options.now - created
  if (ageMs < options.minAgeHours * HOUR_MS) return { skip: { path, name, reason: 'younger-than-min-age' } }

  return { candidate: { path, name, createdAt: created, sizeBytes: await directorySize(path) } }
}

/**
 * List orphaned snapshot directories under a root, oldest first.
 * @param options - root, Host start instant, minimum age in hours, and "now".
 * @returns candidates sorted by creation time, skip records for snapshot-named
 * entries that were refused, and the count of unrelated entries left alone.
 */
export async function scanOrphanSnapshots(options) {
  const { root, hostStartMs: start, minAgeHours, now = Date.now() } = options
  const entries = await readdir(root, { withFileTypes: true })
  const candidates = []
  const skipped = []
  let ignored = 0
  for (const entry of entries) {
    const result = await classify(root, entry, { hostStartMs: start, minAgeHours, now })
    if (result.candidate !== undefined) candidates.push(result.candidate)
    else if (result.skip !== undefined) skipped.push(result.skip)
    else ignored += 1
  }
  candidates.sort((a, b) => a.createdAt - b.createdAt)
  return { candidates, skipped, ignored }
}

/**
 * Remove one snapshot directory, verifying its identity again at the last moment.
 * @param path - absolute snapshot directory path.
 * @returns true when the directory is gone afterwards.
 */
export async function removeSnapshot(path) {
  let info
  try {
    info = await plainDirectory(path)
  } catch {
    return false
  }
  if (info === null) return false
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return true
}
