// src/main/ingestion/hash.ts
//
// Streaming SHA-256 of a file path (ING-04, D-07, D-16). Node's built-in crypto over a read
// stream keeps memory constant regardless of file size, so large scanned PDFs and phone
// photos never load into memory at once (never readFileSync). Source: nodejs.org/api/crypto
// streaming interface. Zero new dependency.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Stream the file at fullPath through SHA-256; resolves the 64-char lowercase hex digest. */
export async function sha256File(fullPath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(fullPath), hash) // backpressure-safe, constant memory
  return hash.digest('hex')
}
