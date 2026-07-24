// test/ingestion-hash.test.ts
//
// Wave-0 (RED) unit spec for the streaming SHA-256 file hasher (ING-04, D-07). Reuses the
// migrate.test.ts temp-dir lifecycle (mkdtempSync/rmSync) so real temp files with known
// bytes are hashed on disk. Until src/main/ingestion/hash.ts exists this file fails to
// import (RED), which is the correct Wave-0 state.
//
// Coverage:
//   - Known-vector correctness: the SHA-256 of an empty file and of the bytes "abc" match
//     the canonical 64-char lowercase hex digests.
//   - Streaming over a large (~5MB) file completes and matches an independently computed
//     one-shot digest, proving the pipeline handles large scans without readFileSync.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sha256File } from '../src/main/ingestion/hash'

// Canonical SHA-256 test vectors (FIPS 180-4 / widely published).
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-hash-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sha256File', () => {
  it('returns the canonical digest of an empty file', async () => {
    const path = join(dir, 'empty.bin')
    writeFileSync(path, Buffer.alloc(0))
    expect(await sha256File(path)).toBe(SHA256_EMPTY)
  })

  it('returns the canonical digest of the bytes "abc"', async () => {
    const path = join(dir, 'abc.bin')
    writeFileSync(path, Buffer.from('abc', 'utf8'))
    const digest = await sha256File(path)
    expect(digest).toBe(SHA256_ABC)
    // 64-char lowercase hex.
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('streams a large (~5MB) file and matches a one-shot digest', async () => {
    const path = join(dir, 'large.bin')
    // ~5MB of a repeated byte pattern; large enough to exercise multiple stream chunks.
    const big = Buffer.alloc(5 * 1024 * 1024, 0xab)
    writeFileSync(path, big)
    const expected = createHash('sha256').update(big).digest('hex')
    expect(await sha256File(path)).toBe(expected)
  })
})
