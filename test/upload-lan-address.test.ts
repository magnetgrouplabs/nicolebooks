// test/upload-lan-address.test.ts
//
// Picking the wrong LAN address is the failure this feature is most likely to ship with, and it is
// completely silent: the QR scans, the phone opens a browser, and the page just never loads. The
// interface tables below are real shapes from real developer machines (WSL, Docker, a VPN tunnel,
// VirtualBox host-only), which is exactly the situation where "the first non-internal IPv4" hands
// out an address only the host itself can route to.
//
// pickLanAddress is a pure function of the interface map precisely so this ranking is provable on
// one OS against tables captured from others.

import { describe, expect, it } from 'vitest'
import {
  LOOPBACK,
  addressRank,
  bestLanAddress,
  pickLanAddress,
  type NetworkAddress
} from '../src/main/upload/lan-address'

const v4 = (address: string, internal = false): NetworkAddress => ({
  address,
  family: 'IPv4',
  internal
})

describe('addressRank prefers the block a home or office router hands out', () => {
  it('ranks 192.168 first, then 10, then 172.16-31', () => {
    expect(addressRank('192.168.1.44')).toBe(0)
    expect(addressRank('10.0.0.8')).toBe(1)
    expect(addressRank('172.17.0.1')).toBe(2)
  })

  it('treats 172.32 and above as ordinary public space, not private', () => {
    // The private block ENDS at 172.31. A regex of /^172\./ would wrongly promote these.
    expect(addressRank('172.32.0.1')).toBe(3)
    expect(addressRank('172.15.0.1')).toBe(3)
    expect(addressRank('172.217.14.206')).toBe(3)
  })

  it('refuses link-local and loopback outright', () => {
    // 169.254 is what Windows self-assigns when DHCP fails: the machine is not on a network at all.
    expect(addressRank('169.254.12.9')).toBeLessThan(0)
    expect(addressRank('127.0.0.1')).toBeLessThan(0)
  })
})

describe('pickLanAddress on real-world interface tables', () => {
  it('picks the Wi-Fi adapter over WSL, Docker, and loopback', () => {
    // Node returns these in an order that is neither documented nor stable, and on this machine
    // the vEthernet bridge comes FIRST. Taking the first non-internal entry would hand the phone
    // 172.28.x, which only the host can reach.
    const picked = pickLanAddress({
      'vEthernet (WSL)': [v4('172.28.192.1')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      'Wi-Fi': [v4('192.168.1.44')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1')]
    })
    expect(picked).toBe('192.168.1.44')
  })

  it('picks a 10.x office address when there is no 192.168 one', () => {
    const picked = pickLanAddress({
      'docker0': [v4('172.17.0.1')],
      'en0': [v4('10.14.3.77')],
      'lo0': [v4('127.0.0.1', true)]
    })
    expect(picked).toBe('10.14.3.77')
  })

  it('falls back to the docker bridge only when it is genuinely the only option', () => {
    expect(pickLanAddress({ 'docker0': [v4('172.17.0.1')] })).toBe('172.17.0.1')
  })

  it('ignores IPv6 entries entirely', () => {
    const picked = pickLanAddress({
      'en0': [
        { address: 'fe80::14d3:9c1e:8b2a:1', family: 'IPv6', internal: false },
        v4('192.168.0.31')
      ]
    })
    expect(picked).toBe('192.168.0.31')
  })

  it('accepts the numeric family older Node versions used', () => {
    const picked = pickLanAddress({
      'en0': [{ address: '192.168.4.2', family: 4, internal: false }]
    })
    expect(picked).toBe('192.168.4.2')
  })

  it('returns null when the machine has only loopback and link-local', () => {
    const picked = pickLanAddress({
      'lo0': [v4('127.0.0.1', true)],
      'Ethernet': [v4('169.254.201.7')]
    })
    expect(picked).toBeNull()
  })

  it('returns null for an empty table', () => {
    expect(pickLanAddress({})).toBeNull()
    expect(pickLanAddress({ 'Ethernet': undefined })).toBeNull()
  })

  it('breaks ties by interface order, so two calls on one machine agree', () => {
    const table = { 'Wi-Fi': [v4('192.168.1.44')], 'Ethernet': [v4('192.168.1.45')] }
    expect(pickLanAddress(table)).toBe(pickLanAddress(table))
    expect(pickLanAddress(table)).toBe('192.168.1.44')
  })
})

describe('bestLanAddress', () => {
  it('returns a usable IPv4 string on this machine, never an empty value', () => {
    // Wi-Fi off is a real state, so loopback is the documented fallback rather than a throw.
    const address = bestLanAddress()
    expect(address).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
    expect(addressRank(address) >= 0 || address === LOOPBACK).toBe(true)
  })
})
