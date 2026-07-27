// test/upload-pick-files.test.ts
//
// The native "Add files" picker, with the OS dialog substituted.
//
// Two properties are worth more than the rest. First, this is a COPY: the user picked a bill out of
// Downloads and the original has to still be there afterwards, because "Add files" must not be a
// destructive verb. Second, the dialog's `filters` list is a HINT on both Windows and macOS (a user
// can still type a name past it), so every returned path is screened again here rather than trusted
// because the dialog was configured a certain way.
//
// electron is mocked because pick-files.ts imports `dialog` at module load, and its transitive
// import of the inbox resolver reaches app.getPath. The inbox is injected, so no real app_settings
// row or database is touched.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => tmpdir() }
}))

import { PICKER_EXTENSIONS, pickFilesIntoInbox } from '../src/main/upload/pick-files'

let source: string
let inbox: string

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), 'nb-source-'))
  inbox = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
})

afterEach(() => {
  rmSync(source, { recursive: true, force: true })
  rmSync(inbox, { recursive: true, force: true })
})

/** Create a file in the fake "user picked this" folder and return its absolute path. */
function makeSource(name: string, contents = 'bytes'): string {
  const path = join(source, name)
  writeFileSync(path, contents)
  return path
}

/** A stub dialog that returns a fixed outcome. */
function dialogReturning(canceled: boolean, filePaths: string[]) {
  return vi.fn().mockResolvedValue({ canceled, filePaths })
}

describe('pickFilesIntoInbox', () => {
  it('copies the chosen files and reports the count', async () => {
    const paths = [makeSource('a.pdf'), makeSource('b.jpg'), makeSource('c.heic')]
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, paths)
    })
    expect(result).toEqual({ added: 3, skipped: [] })
    expect((await readdir(inbox)).sort()).toEqual(['a.pdf', 'b.jpg', 'c.heic'])
  })

  it('COPIES: the file the user picked is still where they left it', async () => {
    const path = makeSource('a.pdf')
    await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, [path])
    })
    expect(existsSync(path)).toBe(true)
  })

  it('treats a cancel as an empty, error-free result', async () => {
    // The user changing their mind is normal and must not raise an alert on the Bills screen.
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(true, [])
    })
    expect(result).toEqual({ added: 0, skipped: [] })
    expect(await readdir(inbox)).toEqual([])
  })

  it('treats an empty selection as a cancel', async () => {
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, [])
    })
    expect(result).toEqual({ added: 0, skipped: [] })
  })

  it('re-screens the extension, because the dialog filter is only a hint', async () => {
    const paths = [makeSource('good.pdf'), makeSource('notes.docx'), makeSource('sheet.xlsx')]
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, paths)
    })
    expect(result.added).toBe(1)
    expect(result.skipped.sort()).toEqual(['notes.docx', 'sheet.xlsx'])
    expect(await readdir(inbox)).toEqual(['good.pdf'])
  })

  it('reports a file it could not read as skipped rather than losing the batch', async () => {
    // One vanished or locked file must not discard the ones that copied fine beside it.
    const paths = [makeSource('a.pdf'), join(source, 'not-there.pdf'), makeSource('b.pdf')]
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, paths)
    })
    expect(result.added).toBe(2)
    expect(result.skipped).toEqual(['not-there.pdf'])
    expect((await readdir(inbox)).sort()).toEqual(['a.pdf', 'b.pdf'])
  })

  it('never overwrites a file already sitting in the inbox', async () => {
    writeFileSync(join(inbox, 'invoice.pdf'), 'already here')
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, [makeSource('invoice.pdf', 'the new one')])
    })
    expect(result.added).toBe(1)
    expect((await readdir(inbox)).sort()).toEqual(['invoice (2).pdf', 'invoice.pdf'])
  })

  it('returns names only, never a path (the T-02-02 boundary)', async () => {
    const result = await pickFilesIntoInbox(null, {
      inboxPath: inbox,
      showOpenDialog: dialogReturning(false, [makeSource('notes.docx')])
    })
    for (const name of result.skipped) {
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(name).not.toContain(source)
    }
  })

  it('offers exactly the extensions the scan can read', () => {
    // Drift here is invisible: the dialog would silently hide a format the pipeline supports, or
    // offer one it cannot read and then skip it after the user picked it.
    expect([...PICKER_EXTENSIONS].sort()).toEqual(['heic', 'heif', 'jpeg', 'jpg', 'pdf', 'png'])
  })
})
