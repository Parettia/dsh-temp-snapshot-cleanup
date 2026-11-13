// Standalone checks for the scanning and deletion rules in lib/scan.js.
// Run: node test/selftest.mjs
// It reads the real temporary directory (read-only) and builds its own fixtures
// under a throwaway `dsh-cleanup-selftest-*` directory, which it removes again.
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = pathToFileURL(join(here, '..', 'lib', 'scan.js')).href
const { scanOrphanSnapshots, removeSnapshot } = await import(lib)

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok   ${label}`)
  else { failures += 1; console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}
const exists = async (path) => { try { await stat(path); return true } catch { return false } }

// --- 1. Real temporary directory, with the live Host start instant ----------
const hostStart = Date.parse('2026-11-13T23:53:40+08:00')
const real = await scanOrphanSnapshots({ root: tmpdir(), hostStartMs: hostStart, minAgeHours: 24, now: Date.now() })
console.log('\n[real tmpdir] candidates:')
for (const c of real.candidates) {
  console.log(`  ${c.name}  ${(c.sizeBytes / 1024 / 1024).toFixed(1)} MB  created ${new Date(c.createdAt).toISOString()}`)
}
console.log('[real tmpdir] snapshot-named skips:')
for (const s of real.skipped) console.log(`  ${s.name}  ${s.reason}`)
console.log(`[real tmpdir] unrelated entries ignored: ${real.ignored}`)
check('real scan returns only dirs older than the Host start', real.candidates.every((c) => c.createdAt < hostStart - 60_000))

// --- 2. Synthetic root: every classification rule ---------------------------
const root = await mkdtemp(join(tmpdir(), 'dsh-cleanup-selftest-'))
const future = Date.now() + 3 * 3_600_000 // pretend the Host started after every fixture existed
const make = async (name, { objects = true, bytes = 1024 } = {}) => {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (objects) {
    await mkdir(join(dir, 'objects'), { recursive: true })
    await writeFile(join(dir, 'objects', 'blob'), Buffer.alloc(bytes, 1))
  }
  return dir
}
const good = await make('dsh-workspace-changes-AAAAA1')
await make('dsh-workspace-changes-BBBBB2', { objects: false })
await make('dsh-workspace-changes-TOOLONG', { objects: true })
await make('unrelated-directory', { objects: true })
await writeFile(join(root, 'dsh-workspace-changes-CCCCC3'), 'file, not a directory')
const target = join(root, 'elsewhere')
await mkdir(target, { recursive: true })
await mkdir(join(target, 'objects'), { recursive: true })
try { await symlink(target, join(root, 'dsh-workspace-changes-DDDDD4'), 'junction') } catch (error) { console.log('note: could not create a link:', error.message) }

const synthetic = await scanOrphanSnapshots({ root, hostStartMs: future, minAgeHours: 0, now: Date.now() })
const reasonOf = (name) => synthetic.skipped.find((s) => s.name === name)?.reason
check('valid old snapshot is a candidate', synthetic.candidates.some((c) => c.name === 'dsh-workspace-changes-AAAAA1'))
check('missing objects marker is skipped', reasonOf('dsh-workspace-changes-BBBBB2') === 'no-objects-directory', reasonOf('dsh-workspace-changes-BBBBB2'))
check('near-miss name is skipped', reasonOf('dsh-workspace-changes-TOOLONG') === 'not-a-snapshot-name', reasonOf('dsh-workspace-changes-TOOLONG'))
check('unrelated entry is only counted', synthetic.ignored === 2 && !synthetic.skipped.some((s) => s.name === 'unrelated-directory'), `ignored=${synthetic.ignored}`)
check('pattern-named file is skipped', reasonOf('dsh-workspace-changes-CCCCC3') === 'not-a-plain-directory', reasonOf('dsh-workspace-changes-CCCCC3'))
check('junction is skipped', ['link-or-redirected', 'not-a-plain-directory'].includes(reasonOf('dsh-workspace-changes-DDDDD4')), String(reasonOf('dsh-workspace-changes-DDDDD4')))
check('size counts the object blobs', synthetic.candidates.find((c) => c.name === 'dsh-workspace-changes-AAAAA1')?.sizeBytes === 1024)

// A directory touched after the Host start must be refused even when it looks old.
const fresh = await scanOrphanSnapshots({ root, hostStartMs: Date.now() - 10_000, minAgeHours: 0, now: Date.now() })
check('directory touched after Host start is skipped', fresh.candidates.length === 0 && fresh.skipped.some((s) => s.reason === 'touched-in-this-host-process'))

// minAgeHours is honoured.
const aged = await scanOrphanSnapshots({ root, hostStartMs: future, minAgeHours: 24, now: Date.now() })
check('young directory fails minAgeHours', aged.candidates.length === 0 && aged.skipped.some((s) => s.reason === 'younger-than-min-age'))

// --- 3. Deletion ------------------------------------------------------------
check('removeSnapshot deletes a real snapshot', (await removeSnapshot(good)) === true && (await exists(good)) === false)
check('removeSnapshot refuses a link', (await removeSnapshot(join(root, 'dsh-workspace-changes-DDDDD4'))) === false && (await exists(target)) === true)
check('removeSnapshot is a no-op for a missing path', (await removeSnapshot(join(root, 'dsh-workspace-changes-ZZZZZ9'))) === false)

await rm(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
