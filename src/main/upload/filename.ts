// src/main/upload/filename.ts
//
// The one place a name coming from OUTSIDE the app is turned into a name that is safe to create
// inside the managed inbox. Two callers feed it: the native "Add files" picker (names come from
// the OS, so they are already well formed) and the phone-upload server (names come off the wire in
// a multipart part header, so they are attacker-shaped until proven otherwise).
//
// Three rules, each load-bearing:
//
//   1. PATH SEPARATORS AND TRAVERSAL DIE HERE. A multipart filename is just a string a client
//      chose; '../../.ssh/authorized_keys' and 'C:\\Windows\\System32\\x.pdf' are both legal to
//      send. Only the final path segment survives, and the result is joined to the inbox by the
//      caller, so nothing an uploader writes can escape the folder.
//
//   2. THE RESULT MUST SURVIVE THE PHASE 2 SCAN. src/main/ingestion/filetype.ts silently DROPS
//      leading-dot names and AppleDouble '._' names as OS junk (D-13). A file saved as '.bill.pdf'
//      would land in the inbox and then vanish from every scan with no message at all, which is the
//      worst possible outcome for a user who just watched their phone say "sent". Leading dots and
//      underscores are stripped so the saved name is always one the scan will classify.
//
//   3. NOTHING IS EVER OVERWRITTEN. Two photos off a phone are routinely both named 'image.jpg',
//      and Nicole's inbox is a working queue, not a cache. Collisions get the familiar
//      'image (2).jpg' treatment rather than replacing bytes that have not been entered yet.
//
// Extension classification is delegated to the shipped isSupported() so the picker, the upload
// server, and the scan can never disagree about what a bill document is.

import { existsSync } from 'node:fs'
import { copyFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isSupported } from '../ingestion/filetype'

/** Longest saved base name. Well under every filesystem's limit, with room for a ' (999)' suffix. */
const MAX_NAME_LENGTH = 180

/** Used when sanitizing leaves nothing at all (a name of only dots, slashes, or control bytes). */
const FALLBACK_NAME = 'upload'

/** Windows forbids these outright; macOS tolerates most of them but they make for hostile names. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/g

/**
 * Reduce an untrusted filename to a single, safe, scannable path segment.
 *
 * Deliberately NOT a validity check: it never throws and never rejects. Type screening is a
 * separate decision made by isSupported() on the RESULT, so a caller always has a concrete name to
 * report back to the user ("we could not accept invoice.docx") instead of an empty string.
 */
export function sanitizeFilename(raw: string): string {
  // 1. Last path segment only. Split on BOTH separators: a Windows client sends backslashes and a
  //    POSIX one sends forward slashes, and Node's basename only understands the host's flavour.
  const segments = String(raw ?? '').split(/[\\/]+/)
  let name = segments[segments.length - 1] ?? ''

  // 2. Whitespace control characters become spaces, so 'home\tdepot.pdf' stays two words rather
  //    than becoming 'homedepot.pdf'. Everything else illegal, invisible, or capable of confusing
  //    a terminal is dropped.
  name = name.replace(/[\t\n\r\v\f]/g, ' ').replace(UNSAFE_CHARS, '')

  // 3. Collapse runs of whitespace and trim. Trailing dots and spaces are stripped too: Windows
  //    silently drops them at create time, so keeping them means the name on disk would not match
  //    the name we told the user we saved.
  name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')

  // 4. Strip leading dots and underscores. See rule 2 in the module header: '.x.pdf' and '._x.pdf'
  //    are both invisible to the scan, so a file saved under either name is lost in silence.
  name = name.replace(/^[._]+/, '')

  if (name === '') return FALLBACK_NAME

  // 5. Length cap, applied to the BASE so the extension (which is what the scan classifies on)
  //    always survives.
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : ''
    const base = dot > 0 ? name.slice(0, dot) : name
    name = `${base.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length))}${ext}`
  }

  return name
}

/**
 * True when a sanitized name is one of the bill formats the pipeline can actually read.
 * Thin wrapper so callers here never re-implement the extension list that filetype.ts owns.
 */
export function isSupportedName(name: string): boolean {
  return isSupported(name)
}

/**
 * The name to actually create in `dir`, given the name we WANT. Returns `desired` unchanged when
 * nothing is in the way, otherwise 'name (2).ext', 'name (3).ext', and so on.
 *
 * The existsSync loop races in theory: two phone uploads landing in the same millisecond could both
 * resolve to the same free name. Both callers are strictly serialized (the picker copies in a loop,
 * the server moves files one at a time after the request body is fully received), so the window
 * never opens in practice, and the counter is bounded so a pathological directory cannot spin.
 */
export function resolveCollision(dir: string, desired: string): string {
  if (!existsSync(join(dir, desired))) return desired

  const dot = desired.lastIndexOf('.')
  const ext = dot > 0 ? desired.slice(dot) : ''
  const base = dot > 0 ? desired.slice(0, dot) : desired

  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${base} (${n})${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }

  // 998 same-named files is not a real inbox; fall back to a timestamp rather than give up.
  return `${base} (${Date.now()})${ext}`
}

/**
 * Copy `sourcePath` into `inboxPath` under a sanitized, collision-free name. Returns the name that
 * was created. Used by the native picker, which must leave the user's original file where it is.
 */
export async function copyIntoInbox(
  inboxPath: string,
  sourcePath: string,
  desiredName: string
): Promise<string> {
  const name = resolveCollision(inboxPath, sanitizeFilename(desiredName))
  await copyFile(sourcePath, join(inboxPath, name))
  return name
}

/**
 * Move a fully-written staging file into `inboxPath` under a sanitized, collision-free name.
 * Returns the name that was created.
 *
 * rename() is atomic, which is exactly what the inbox needs: the scan's settling gate would skip a
 * half-written file, but a same-volume rename means it never sees one at all. The staging directory
 * lives in the OS temp area and the inbox lives under Documents, so those can legitimately be
 * different volumes (a Documents folder redirected to a second drive is common on Windows); EXDEV
 * falls back to copy-then-unlink, which reintroduces the partial-file window that the settling gate
 * already covers.
 */
export async function moveIntoInbox(
  inboxPath: string,
  sourcePath: string,
  desiredName: string
): Promise<string> {
  const name = resolveCollision(inboxPath, sanitizeFilename(desiredName))
  const target = join(inboxPath, name)
  try {
    await rename(sourcePath, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(sourcePath, target)
    await unlink(sourcePath).catch(() => {})
  }
  return name
}
