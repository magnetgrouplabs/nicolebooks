// src/main/recon/service.ts
//
// The one reconciliation operation the IPC layer exposes: take a batch of file hashes, look up what
// the parser found for each, and rank it against the cached QuickBooks reference lists.
//
// This file exists so src/main/ipc/recon.ts stays what every other handler module in this codebase
// is: a sender gate, a Zod gate, a call, and an error map. It is pure orchestration with injectable
// dependencies (Shared Pattern B), so the unit spec drives whole batches against a temp database and
// a fixture reference set, with no Electron and no network.
//
// HASHES IN, MATCHES OUT (the seam rule from SEAMS-NOTES section 8, item 10). The renderer sends
// hashes only. The vendor and category TEXT is read here, main-side, from the parsed_results cache
// the Phase 3 pipeline wrote. Accepting that text from the renderer would let a compromised
// renderer steer a match against words the parser never produced, and would give the same fact two
// sources of truth.
//
// NOTHING IS CREATED, AND NOTHING WRITES (RECON-03). This module reads two caches and returns a
// ranking. It has no INSERT, no QuickBooks call, and no code path that could create a vendor or an
// account; matching is a read-only opinion, and only a person choosing in the review grid turns it
// into a posted entry.
//
// LOCAL ONLY. Both reads are SQLite. Matching a batch never touches the network, so it works
// offline against the last sync and cannot put a round trip on the path of a screen the user is
// waiting for.
//
// ONE BAD FILE NEVER FAILS THE BATCH (the D-15 per-file isolation rule). A hash with no cached parse
// comes back as two 'none' results rather than as a thrown error, because a batch of nine documents
// where one failed to parse must still reconcile the other eight.

import type Database from 'better-sqlite3'
import type { FileMatch, QboReference, ReconMatchResult } from '../../shared/ipc-contract'
import { getCached } from '../parse/cache'
import { getDatabase } from '../db/connection'
import { getLastSyncAt, getRealmId, type ConnectionDeps } from '../qbo/connection'
import { readReference } from '../qbo/reference'
import { matchAgainst, noMatch, type MatchOption } from './match'

/** No QuickBooks company is connected, so there is nothing to match against. */
export const RECON_NOT_CONNECTED = 'RECON_NOT_CONNECTED'

/**
 * A company is connected but its reference cache is empty, so every row would come back unmatched.
 *
 * Surfacing this as a failure rather than as nine empty rows is deliberate: "nothing matched" and
 * "the lists were never downloaded" look identical in the review grid, and only one of them has a
 * one-click fix.
 */
export const RECON_REFERENCE_EMPTY = 'RECON_REFERENCE_EMPTY'

/** Injectable dependencies. `reference` lets a spec supply a fixture cache with no sync. */
export interface ReconDeps extends ConnectionDeps {
  db?: Database.Database
  reference?: QboReference
}

/**
 * Match every hash in the batch. Keyed by file hash, the same join key as scan, parse and posting.
 *
 * An empty batch returns an empty result WITHOUT touching either cache: a scan that loaded nothing
 * is not an error, and asking a disconnected app to match zero documents should not lecture the
 * user about connecting.
 *
 * Duplicate hashes collapse into one entry, which is correct rather than merely harmless: the
 * result is a map keyed by hash, and the same document cannot have two different matches.
 */
export function matchBatch(
  fileHashes: readonly string[],
  deps: ReconDeps = {}
): ReconMatchResult {
  const matches: Record<string, FileMatch> = {}
  if (fileHashes.length === 0) return { matches }

  const reference = resolveReference(deps)
  const vendorOptions = vendorCandidates(reference)
  const categoryOptions = categoryCandidates(reference)
  if (vendorOptions.length === 0 && categoryOptions.length === 0) {
    throw new Error(RECON_REFERENCE_EMPTY)
  }

  const db = deps.db ?? getDatabase()
  for (const fileHash of fileHashes) {
    if (matches[fileHash]) continue
    const cached = getCached(db, fileHash)
    if (!cached) {
      // No parse on record: the file failed, or was never parsed. Two empty cells, no exception.
      matches[fileHash] = { vendor: noMatch(), category: noMatch() }
      continue
    }
    matches[fileHash] = {
      vendor: matchAgainst(cached.fields.vendor, vendorOptions),
      category: matchAgainst(cached.fields.suggestedCategory, categoryOptions)
    }
  }

  return { matches }
}

/**
 * Vendor candidates: the display name is both what is matched against and what is shown, because a
 * vendor name has no hierarchy to disambiguate.
 *
 * Inactive rows are dropped. The cache deliberately keeps a vendor that disappeared upstream so an
 * already-posted entry can still resolve its name, but offering it as a new choice would post a
 * bill against a vendor QuickBooks has retired.
 */
export function vendorCandidates(reference: QboReference): MatchOption[] {
  return reference.vendors
    .filter((vendor) => vendor.active)
    .map((vendor) => ({ id: vendor.id, name: vendor.name, matchText: vendor.name, active: true }))
}

/**
 * Category candidates: expense accounts ONLY (RECON-04).
 *
 * The account-type split already happened in the cache (expenseAccounts vs paymentAccounts), so
 * this function cannot accidentally offer a Bank or Credit Card account as a category; there is no
 * filter here to get wrong, because the wrong accounts are not in the list it reads.
 *
 * MATCH ON THE LEAF, SHOW THE PATH. A bill says "Job Materials"; QuickBooks calls that account
 * "Job Expenses:Job Materials". Matching against the fully qualified name would penalise every
 * sub-account for the parent it happens to sit under, and showing the bare leaf would offer
 * 'Equipment Rental' twice with no way to tell the two apart.
 */
export function categoryCandidates(reference: QboReference): MatchOption[] {
  return reference.expenseAccounts
    .filter((account) => account.active)
    .map((account) => ({
      id: account.id,
      name: account.name,
      matchText: account.shortName,
      active: true
    }))
}

/**
 * The reference set to rank against: injected in tests, read from the realm-scoped cache otherwise.
 *
 * The not-connected check happens here rather than inside readReference because readReference
 * answers a disconnected app with empty lists by design, and an empty list is indistinguishable
 * from "this company has no vendors" at the call site.
 */
function resolveReference(deps: ReconDeps): QboReference {
  if (deps.reference) return deps.reference
  const realmId = getRealmId(deps)
  if (!realmId) throw new Error(RECON_NOT_CONNECTED)
  return readReference(realmId, getLastSyncAt(deps), deps.db)
}
