/**
 * Reclaims disk space taken by orphaned `dsh-workspace-changes-*` snapshot
 * directories. The built-in `@deepseek-ai/dsh-workspace-changes` plugin creates
 * one temporary git object directory per Session under the system temporary
 * directory and deletes it when that Session is released; a Host that was
 * killed, crashed, or force-quit leaves the directories behind, each usually
 * between 0.5 GB and 2.5 GB.
 *
 * A directory is removed only when every safety rule in `lib/scan.js` holds:
 * it is a direct child of the temporary directory whose name is exactly
 * `dsh-workspace-changes-` plus six alphanumerics, it is a plain directory
 * rather than a link or junction, it contains the `objects` snapshot marker,
 * every timestamp it reports predates this Host process by at least 60 seconds,
 * and it is at least `minAgeHours` old. Anything else is skipped, and the whole
 * run is wrapped so a failure can only ever produce a warning.
 *
 * `dryRun` defaults to true: the first start only reports what it would remove.
 */
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { hostStartMs, removeSnapshot, scanOrphanSnapshots } from './lib/scan.js'

/** Stable Loader identity. */
export const name = 'temp-snapshot-cleanup'

/**
 * Cleanup bounds; see the schema below for defaults and meaning.
 * @typedef {object} Config
 * @property {boolean} enabled - master switch; false makes the plugin idle.
 * @property {boolean} dryRun - report candidates without removing them.
 * @property {number} minAgeHours - minimum age in hours, from the creation time.
 * @property {number} maxDirsPerRun - upper bound on directories handled per run.
 * @property {number} intervalHours - hours between runs; 0 runs once per Host start.
 * @property {number} startupDelayMs - delay after activation before the first run.
 * @property {string} tempRoot - directory to scan; empty means the platform temporary directory.
 */

/** Schemastery validation for {@link Config}. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Clean orphaned snapshot directories at all.'),
  dryRun: Schema.boolean().default(true).description('Report candidates without removing them.'),
  minAgeHours: Schema.number().default(24).description('Minimum age in hours.'),
  maxDirsPerRun: Schema.number().default(20).description('Upper bound on directories removed per run.'),
  intervalHours: Schema.number().default(0).description('Hours between runs; 0 runs once per Host start.'),
  startupDelayMs: Schema.number().default(5_000).description('Delay after activation before the first run.'),
  tempRoot: Schema.string().default('').description('Temporary directory to scan; empty means the platform temporary directory.'),
})

const HOUR_MS = 3_600_000
const MIB = 1024 * 1024

/**
 * Collect the logger shortcuts used here, tolerating a context without one.
 * @param ctx - Host context.
 * @returns info, warn, and debug sinks that never throw.
 */
function loggerOf(ctx) {
  const logger = ctx?.logger
  const at = (level) => (message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      // Logging must never break the cleanup.
    }
  }
  return { info: at('info'), warn: at('warn'), debug: at('debug') }
}

/**
 * Whether `path` is `parent` or lies below it.
 * @param parent - absolute directory.
 * @param path - absolute path to test.
 * @returns true for the parent itself and every descendant.
 */
function isInside(parent, path) {
  const relative = path.slice(parent.length)
  return path === parent || (path.startsWith(parent) && /^[\\/]/.test(relative))
}

/**
 * Coerce one numeric setting into its accepted range.
 * @param value - configured value.
 * @param fallback - schema default.
 * @param minimum - smallest accepted value.
 * @param maximum - largest accepted value.
 * @param log - warning sink.
 * @param field - field name used in the warning.
 * @returns the coerced value.
 */
function numberSetting(value, fallback, minimum, maximum, log, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    log.warn(`temp-snapshot-cleanup: ignoring invalid ${field}, using ${fallback}`)
    return fallback
  }
  const clamped = Math.min(maximum, Math.max(minimum, value))
  if (clamped !== value) log.warn(`temp-snapshot-cleanup: ${field} must stay within [${minimum}, ${maximum}]; using ${clamped}`)
  return clamped
}

/**
 * Verify the root that will be scanned before anything is read from it.
 * @param root - resolved candidate root.
 * @param log - warning sink.
 * @returns the root, or null when it must not be scanned at all.
 */
function checkRoot(root, log) {
  if (dirname(root) === root) {
    log.warn(`temp-snapshot-cleanup: refusing to scan a filesystem root (${root})`)
    return null
  }
  const home = process.env.DSH_HOME
  const guarded = [home, resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')].filter((value) => value && value !== '')
  for (const directory of guarded) {
    if (isInside(resolve(directory), root)) {
      log.warn(`temp-snapshot-cleanup: refusing to scan inside ${directory}`)
      return null
    }
  }
  return root
}

/**
 * Report or remove orphaned snapshot directories, then schedule further runs.
 * @param ctx - Host context.
 * @param config - validated configuration.
 */
export function apply(ctx, config) {
  const log = loggerOf(ctx)
  if (config?.enabled === false) return

  const minAgeHours = numberSetting(config?.minAgeHours, 24, 1, 24 * 365, log, 'minAgeHours')
  const maxDirsPerRun = Math.floor(numberSetting(config?.maxDirsPerRun, 20, 1, 1_000, log, 'maxDirsPerRun'))
  const intervalHours = numberSetting(config?.intervalHours, 0, 0, 24 * 365, log, 'intervalHours')
  const startupDelayMs = numberSetting(config?.startupDelayMs, 5_000, 0, HOUR_MS, log, 'startupDelayMs')
  const dryRun = config?.dryRun !== false
  const root = checkRoot(resolve(typeof config?.tempRoot === 'string' && config.tempRoot !== '' ? config.tempRoot : tmpdir()), log)
  if (root === null) return

  const startedAt = hostStartMs()
  log.debug(`temp-snapshot-cleanup: scanning ${root} (dryRun=${dryRun}, minAgeHours=${minAgeHours}, hostStart=${new Date(startedAt).toISOString()})`)

  let running = false
  const bytes = (value) => (value / MIB).toFixed(1)

  const runOnce = async (trigger) => {
    if (running) {
      log.debug('temp-snapshot-cleanup: previous run is still in progress; skipping')
      return
    }
    running = true
    try {
      const { candidates, skipped, ignored } = await scanOrphanSnapshots({
        root, hostStartMs: startedAt, minAgeHours, now: Date.now(),
      })
      for (const record of skipped) log.debug(`temp-snapshot-cleanup: skipped ${record.name} (${record.reason})`)
      log.debug(`temp-snapshot-cleanup: left ${ignored} unrelated temporary entries alone`)

      const reasons = skipped.reduce((counts, record) => {
        counts[record.reason] = (counts[record.reason] ?? 0) + 1
        return counts
      }, {})
      if (skipped.length > 0) {
        log.debug(`temp-snapshot-cleanup: skip reasons ${JSON.stringify(reasons)}`)
      }

      if (candidates.length === 0) {
        log.info(`temp-snapshot-cleanup: ${trigger}: no orphaned snapshot directories, freed 0.0 MB (skipped ${skipped.length})`)
        return
      }

      const selected = candidates.slice(0, maxDirsPerRun)
      const reclaimable = selected.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)

      if (dryRun) {
        for (const candidate of selected) {
          const created = new Date(candidate.createdAt).toISOString()
          log.info(`temp-snapshot-cleanup: dry run, would remove ${candidate.path} (${bytes(candidate.sizeBytes)} MB, created ${created})`)
        }
        if (candidates.length > selected.length) {
          log.info(`temp-snapshot-cleanup: dry run, ${candidates.length - selected.length} further candidate(s) wait for a later run (maxDirsPerRun=${maxDirsPerRun})`)
        }
        log.info(`temp-snapshot-cleanup: ${trigger}: dry run, removed 0 dirs, ${bytes(reclaimable)} MB reclaimable from ${selected.length} candidate(s) (skipped ${skipped.length})`)
        return
      }

      let removed = 0
      let freed = 0
      for (const candidate of selected) {
        try {
          if (!(await removeSnapshot(candidate.path))) {
            log.warn(`temp-snapshot-cleanup: left ${candidate.path} in place, it is no longer a plain directory`)
            continue
          }
          removed += 1
          freed += candidate.sizeBytes
          log.debug(`temp-snapshot-cleanup: removed ${candidate.path} (${bytes(candidate.sizeBytes)} MB)`)
        } catch (error) {
          log.warn(`temp-snapshot-cleanup: could not remove ${candidate.path}: ${error?.message ?? error}`)
        }
      }
      log.info(`temp-snapshot-cleanup: ${trigger}: removed ${removed} dirs, freed ${bytes(freed)} MB (skipped ${skipped.length})`)
    } catch (error) {
      log.warn(`temp-snapshot-cleanup: cleanup run failed: ${error?.message ?? error}`)
    } finally {
      running = false
    }
  }

  ctx.effect(() => {
    const timer = setTimeout(() => { void runOnce('startup') }, startupDelayMs)
    return () => clearTimeout(timer)
  })

  if (intervalHours > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => { void runOnce('scheduled') }, intervalHours * HOUR_MS)
      return () => clearInterval(timer)
    })
  }
}
