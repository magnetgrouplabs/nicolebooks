// src/main/upload/lan-address.ts
//
// Which IPv4 address to print in the phone-pairing URL.
//
// This is the single hardest thing about the phone-upload feature to get right, and it fails
// silently when it is wrong: the QR code scans, the phone opens a browser, and the page simply
// never loads. A developer machine routinely offers half a dozen non-internal IPv4 addresses --
// WSL's vEthernet bridge, Docker's bridge, a VPN tunnel, VirtualBox host-only, plus the real
// Wi-Fi adapter -- and os.networkInterfaces() returns them in an order that is neither documented
// nor stable. Taking "the first non-internal IPv4" is the common shortcut and it hands out an
// address that only the host machine can route to.
//
// So the choice is explicitly RANKED by RFC 1918 block instead. A phone and a laptop on the same
// house or office network are on the same private block, and 192.168/16 is what consumer routers
// hand out, so it wins; 10/8 (larger office networks, and some routers) is next; 172.16/12 is last
// of the three because it is also what Docker's default bridge uses, and a Docker bridge address is
// exactly the wrong answer. Link-local (169.254/16, the address Windows self-assigns when DHCP
// fails) is excluded outright: an interface holding one is not on a working network at all.
//
// The picker is a pure function of an interface map so the ranking is unit-testable on one OS
// against interface tables captured from others.

import { networkInterfaces } from 'node:os'

/** The shape this module needs from os.networkInterfaces(), narrowed so tests can hand-build one. */
export interface NetworkAddress {
  address: string
  /** Node has used both the string 'IPv4' (>= 18) and the number 4 (older) here. Accept both. */
  family: string | number
  internal: boolean
}

/** Loopback, used when the machine is genuinely not on a network. Only the host itself can reach it. */
export const LOOPBACK = '127.0.0.1'

function isIpv4(entry: NetworkAddress): boolean {
  return entry.family === 'IPv4' || entry.family === 4
}

/**
 * Preference rank for a candidate address. Lower is better; a negative rank means "never use this".
 * Exported because the ranking IS the behaviour worth pinning in a test.
 */
export function addressRank(address: string): number {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  // 172.16.0.0 - 172.31.255.255. 172.32+ is public space and must not match.
  const privateB = /^172\.(1[6-9]|2\d|3[01])\./.exec(address)
  if (privateB) return 2
  if (address.startsWith('169.254.')) return -1 // link-local: DHCP failed, nothing can reach us
  if (address.startsWith('127.')) return -1 // loopback: the phone cannot route to it
  return 3 // some other routable address; usable, but only if nothing private is available
}

/**
 * Best LAN address from an interface map, or null when the machine has no usable one.
 *
 * Ties are broken by the order os.networkInterfaces() returned, which keeps the answer stable
 * between two calls on an unchanged machine (a URL that changes shape between two clicks of
 * "Add from phone" reads as a bug even when both addresses work).
 */
export function pickLanAddress(
  interfaces: Record<string, NetworkAddress[] | undefined>
): string | null {
  let best: { address: string; rank: number } | null = null

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!isIpv4(entry) || entry.internal) continue
      const rank = addressRank(entry.address)
      if (rank < 0) continue
      if (!best || rank < best.rank) best = { address: entry.address, rank }
    }
  }

  return best?.address ?? null
}

/**
 * The address to print in the pairing URL. Falls back to loopback rather than throwing: a machine
 * with no LAN is a real state (Wi-Fi off), and the UI can still show a URL that proves the server
 * is up, which is far easier to explain than an error with no address in it.
 */
export function bestLanAddress(): string {
  return pickLanAddress(networkInterfaces() as Record<string, NetworkAddress[] | undefined>) ?? LOOPBACK
}
