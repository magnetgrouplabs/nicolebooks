// test/ingestion-materialization.test.ts
//
// Wave-0 (RED) spec for the materialization gate (ING-03, D-11, SC4): cloud-sync placeholder
// detection + the bounded partial-write settling poll. Until src/main/ingestion/materialization.ts
// exists this file fails to import (RED), the correct Wave-0 state.
//
// Two tiers:
//   1. Injected-metadata unit tier (deterministic on ANY CI OS): a fake stat and a fake Windows
//      attribute reader simulate macOS dataless files (blocks===0), the legacy .icloud sentinel,
//      and Windows OFFLINE/RECALL attribute bits — plus the inconclusive-detection fallback where
//      a failed/empty Windows read LOADS (returns false) rather than false-skipping a real bill.
//   2. Real-fs integration tier: a temp file kept growing by a background writer must NOT settle
//      until writing stops (never hash a half-written file).
//
// The functions are injectable (a `platform` arg + a `deps` object with stat/readWinFlags) so both
// OS branches are exercised on one host, mirroring the connection.ts openDatabase injectability.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNotMaterialized, isSettled } from '../src/main/ingestion/materialization'

// Windows attribute bits (bit-tested against the raw [int64] Attributes integer).
const FILE_ATTRIBUTE_OFFLINE = 0x1000
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000
const FILE_ATTRIBUTE_ARCHIVE = 0x20

describe('isNotMaterialized (metadata-only placeholder detection)', () => {
  describe('macOS dataless files (blocks === 0)', () => {
    it('flags a dataless file (size > 0, blocks === 0) as not materialized', async () => {
      const stat = async (): Promise<{ size: number; blocks: number }> => ({ size: 12345, blocks: 0 })
      expect(
        await isNotMaterialized('/inbox/bill.pdf', new Set(), 'bill.pdf', 'darwin', { stat })
      ).toBe(true)
    })

    it('treats a fully-allocated file (blocks > 0) as materialized', async () => {
      const stat = async (): Promise<{ size: number; blocks: number }> => ({ size: 12345, blocks: 24 })
      expect(
        await isNotMaterialized('/inbox/bill.pdf', new Set(), 'bill.pdf', 'darwin', { stat })
      ).toBe(false)
    })
  })

  describe('legacy iCloud .icloud sentinel', () => {
    it('flags a file whose .<name>.icloud sibling exists (even if it looks allocated)', async () => {
      // Allocated-looking stat, but a sentinel sibling means the real file is evicted.
      const stat = async (): Promise<{ size: number; blocks: number }> => ({ size: 200, blocks: 8 })
      const siblings = new Set(['bill.pdf', '.bill.pdf.icloud'])
      expect(
        await isNotMaterialized('/inbox/bill.pdf', siblings, 'bill.pdf', 'darwin', { stat })
      ).toBe(true)
    })
  })

  describe('Windows offline / recall attributes', () => {
    it('flags RECALL_ON_DATA_ACCESS (0x400000) as not materialized', async () => {
      const readWinFlags = async (): Promise<Map<string, number>> =>
        new Map([['bill.pdf', FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_ARCHIVE]])
      expect(
        await isNotMaterialized('C:/inbox/bill.pdf', new Set(), 'bill.pdf', 'win32', { readWinFlags })
      ).toBe(true)
    })

    it('flags FILE_ATTRIBUTE_OFFLINE (0x1000) as not materialized', async () => {
      const readWinFlags = async (): Promise<Map<string, number>> =>
        new Map([['bill.pdf', FILE_ATTRIBUTE_OFFLINE]])
      expect(
        await isNotMaterialized('C:/inbox/bill.pdf', new Set(), 'bill.pdf', 'win32', { readWinFlags })
      ).toBe(true)
    })

    it('flags RECALL_ON_OPEN (0x40000) as not materialized', async () => {
      const readWinFlags = async (): Promise<Map<string, number>> =>
        new Map([['bill.pdf', FILE_ATTRIBUTE_RECALL_ON_OPEN]])
      expect(
        await isNotMaterialized('C:/inbox/bill.pdf', new Set(), 'bill.pdf', 'win32', { readWinFlags })
      ).toBe(true)
    })

    it('treats an archive-only file (0x20) as materialized', async () => {
      const readWinFlags = async (): Promise<Map<string, number>> =>
        new Map([['bill.pdf', FILE_ATTRIBUTE_ARCHIVE]])
      expect(
        await isNotMaterialized('C:/inbox/bill.pdf', new Set(), 'bill.pdf', 'win32', { readWinFlags })
      ).toBe(false)
    })
  })

  describe('inconclusive-detection fallback (LOAD on total detection failure)', () => {
    it('loads (returns false) when the Windows attribute read throws', async () => {
      const readWinFlags = async (): Promise<Map<string, number>> => {
        throw new Error('powershell unavailable')
      }
      expect(
        await isNotMaterialized('C:/inbox/bill.pdf', new Set(), 'bill.pdf', 'win32', { readWinFlags })
      ).toBe(false)
    })

    it('loads (returns false) when the file is absent from the attribute map', async () => {
      const readWinFlags = async (): Promise<Map<string, number>> => new Map<string, number>()
      expect(
        await isNotMaterialized('C:/inbox/bill.pdf', new Set(), 'bill.pdf', 'win32', { readWinFlags })
      ).toBe(false)
    })
  })
})

describe('isSettled (bounded size + mtime settling poll, real fs)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nb-settle-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not settle while a file is actively growing, then settles once writing stops', async () => {
    const path = join(dir, 'growing.pdf')
    const fd = openSync(path, 'w')
    let stop = false
    try {
      writeSync(fd, Buffer.from('first-chunk-'))

      // Background writer keeps appending while the poll runs.
      const writer = (async (): Promise<void> => {
        while (!stop) {
          try {
            writeSync(fd, Buffer.from('more-bytes-'))
          } catch {
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 15))
        }
      })()

      // While the file grows, the poll must NOT settle within its budget.
      const settledWhileWriting = await isSettled(path, { intervalMs: 30, maxSamples: 6 })
      expect(settledWhileWriting).toBe(false)

      stop = true
      await writer
    } finally {
      closeSync(fd)
    }

    // Writing has stopped: a fresh poll now settles (two consecutive equal samples).
    const settledAfterStop = await isSettled(path, { intervalMs: 30, maxSamples: 6 })
    expect(settledAfterStop).toBe(true)
  })
})
