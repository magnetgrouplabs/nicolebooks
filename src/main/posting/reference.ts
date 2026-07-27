// src/main/posting/reference.ts
//
// The second seam: the names and account types the posting engine needs but does not own.
//
// A review row carries QuickBooks IDs and nothing else, on purpose (the renderer never gets to
// send a name that steers a lookup). But two things downstream need more than an id:
//
//   1. THE REPORT. A printable batch summary that says "Vendor 42 paid from Account 35" is not a
//      report. The names are therefore DENORMALIZED onto posting_entries at post time, not joined
//      at read time, so the summary still prints correctly months later even if the vendor was
//      renamed, merged, or made inactive in QuickBooks. An audit row should say what was true when
//      it was written.
//
//   2. THE PAYMENT TYPE. A Purchase must declare 'CreditCard' or 'Check', and the only thing that
//      decides it is the paid-from account's QuickBooks AccountType.
//
// Both facts live in QBO-CONNECT's reference cache (migration 0004), which is written in a
// parallel worktree. Rather than guess at its table names, this module is a REGISTRATION HOOK with
// a null default: unresolved names simply stay null, everything else works, and the integration
// wave supplies a real resolver in one call.
//
// >>> INTEGRATION WAVE / REVIEW-UI, THIS IS YOUR HOOK <<<
// setPostingReference({ companyName, vendorName, accountName, accountType }) once at startup,
// backed by the QBO reference cache. Until then a summary prints the id in place of a missing
// name (see summary.ts) and every Purchase posts as 'Check', which is the safe neutral default.

/**
 * Everything the posting engine wants to know that lives outside it. Every method is allowed to
 * return null: an unresolved name degrades the report, it must never fail a post.
 */
export interface PostingReference {
  /** Display name of the connected QuickBooks company, for the report header. */
  companyName(): string | null
  vendorName(vendorId: string): string | null
  accountName(accountId: string): string | null
  /** The QuickBooks AccountType, e.g. 'Bank' or 'Credit Card'. Decides a Purchase PaymentType. */
  accountType(accountId: string): string | null
}

/** The pre-integration default: knows nothing, breaks nothing. */
export const NULL_POSTING_REFERENCE: PostingReference = {
  companyName: () => null,
  vendorName: () => null,
  accountName: () => null,
  accountType: () => null
}

let current: PostingReference = NULL_POSTING_REFERENCE

/** Register the live resolver. Passing null restores the null resolver (what a disconnect does). */
export function setPostingReference(next: PostingReference | null): void {
  current = next ?? NULL_POSTING_REFERENCE
}

/** The resolver in force. Every posting entry point takes it as an argument defaulted to this. */
export function getPostingReference(): PostingReference {
  return current
}

/**
 * Wrap a resolver so a throwing implementation degrades to null instead of failing a batch.
 *
 * The reference cache is a SQLite read behind an interface somebody else implements. If it throws
 * (a missing table on a half-migrated database is the realistic case), losing a name is an
 * acceptable outcome and losing the batch is not.
 */
export function safeReference(reference: PostingReference): PostingReference {
  const guard = <T>(fn: () => T | null): T | null => {
    try {
      return fn()
    } catch {
      return null
    }
  }
  return {
    companyName: () => guard(() => reference.companyName()),
    vendorName: (id) => guard(() => reference.vendorName(id)),
    accountName: (id) => guard(() => reference.accountName(id)),
    accountType: (id) => guard(() => reference.accountType(id))
  }
}
