// test/helpers/fake-secret-store.ts
//
// The shared secret-store double for the QuickBooks unit specs. It satisfies SecretStoreLike, so
// every module that takes `deps.secretStore` runs against it with no Electron and no safeStorage.
//
// It records the WRITE ORDER, which is not decoration. The one rule the token lifecycle exists to
// enforce is that the rotated refresh token is persisted before the new access token is used, and
// the only way to prove an ordering is to observe it. `writes` is the sequence of [key, value]
// pairs in the order they were set, and `keysWritten` is the same thing without the values, so an
// assertion can name the order without ever putting a token in the failure output.

/** A fake keychain that records everything done to it. */
export interface FakeSecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  available(): boolean
  /** Every set() in call order, as [key, value]. */
  writes: Array<[string, string]>
  /** Every set() in call order, keys only. Safe to print in a failure message. */
  keysWritten: string[]
  /** Every delete() in call order. */
  deletes: string[]
  /** Direct access to the underlying map, for arranging a starting state. */
  values: Map<string, string>
  /** Flip to make available() report false, exercising the keychain-unavailable path. */
  encryptionAvailable: boolean
}

/** Build a fake store, optionally pre-seeded. */
export function createFakeSecretStore(initial: Record<string, string> = {}): FakeSecretStore {
  const values = new Map<string, string>(Object.entries(initial))
  const writes: Array<[string, string]> = []
  const keysWritten: string[] = []
  const deletes: string[] = []

  const store: FakeSecretStore = {
    values,
    writes,
    keysWritten,
    deletes,
    encryptionAvailable: true,
    available(): boolean {
      return store.encryptionAvailable
    },
    get(key: string): string | null {
      return values.get(key) ?? null
    },
    set(key: string, value: string): void {
      values.set(key, value)
      writes.push([key, value])
      keysWritten.push(key)
    },
    delete(key: string): void {
      values.delete(key)
      deletes.push(key)
    }
  }

  return store
}

/** Build a minimal JSON Response, the shape a fake fetch hands back. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** Build a plain-text error Response, the shape Intuit's token endpoint returns on a failure. */
export function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}
