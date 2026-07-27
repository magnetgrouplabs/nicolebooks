// test/posting-builders.test.ts
//
// The pure entity builders. This is the file that stands between a parsed document and somebody's
// books, so it is tested hardest.
//
// The money assertions are the point. `cents / 100` looks correct and passes a casual test; it is
// float division, and this is a financial tool. Every value below is checked against a string the
// integer path produces exactly, including the three shapes that break naive implementations:
// zero, a value under one dollar, and a value large enough to matter.

import { describe, expect, it } from 'vitest'
import {
  QBO_MINOR_VERSION,
  buildBillPayload,
  buildPurchasePayload,
  centsToDecimalString,
  createEntityPath,
  deleteEntityPath,
  entityNameFor,
  paymentTypeForAccount,
  readEntityPath,
  type EntityRowInput
} from '../src/main/posting/entity-builders'

function billInput(overrides: Partial<EntityRowInput> = {}): EntityRowInput {
  return {
    entryType: 'bill',
    vendorId: '42',
    categoryAccountId: '7',
    paidFromAccountId: null,
    txnDate: '2026-07-27',
    dueDate: '2026-08-26',
    refNumber: 'INV-1001',
    amountCents: 12345,
    memo: null,
    ...overrides
  }
}

function expenseInput(overrides: Partial<EntityRowInput> = {}): EntityRowInput {
  return billInput({ entryType: 'expense', paidFromAccountId: '35', dueDate: null, ...overrides })
}

describe('centsToDecimalString', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [9, '0.09'],
    [10, '0.10'],
    [99, '0.99'],
    [100, '1.00'],
    [101, '1.01'],
    [999, '9.99'],
    [1000, '10.00'],
    [12345, '123.45'],
    [100000, '1000.00'],
    [999999999, '9999999.99']
  ])('renders %i cents as %s', (cents, expected) => {
    expect(centsToDecimalString(cents)).toBe(expected)
  })

  it('never loses a cent to float division on a value that round trips badly', () => {
    // 8.35 and 0.29 are the classic binary-floating-point offenders. The integer path cannot see
    // them at all, which is exactly why it is the integer path.
    expect(centsToDecimalString(835)).toBe('8.35')
    expect(centsToDecimalString(29)).toBe('0.29')
    expect(centsToDecimalString(70)).toBe('0.70')
  })

  it('always emits exactly two decimal places', () => {
    for (let cents = 0; cents < 1000; cents += 1) {
      expect(centsToDecimalString(cents)).toMatch(/^\d+\.\d{2}$/)
    }
  })

  it('rejects a negative amount rather than emitting one', () => {
    // A negative line is a credit memo or a refund, and this app posts neither. Letting one out
    // would create an entry that reads as a bill and behaves as a credit.
    expect(() => centsToDecimalString(-1)).toThrow('POSTING_AMOUNT_NEGATIVE')
    expect(() => centsToDecimalString(-12345)).toThrow('POSTING_AMOUNT_NEGATIVE')
  })

  it('rejects a non-integer, because a fractional cent means a float already happened upstream', () => {
    expect(() => centsToDecimalString(123.45)).toThrow('POSTING_AMOUNT_NOT_INTEGER')
    expect(() => centsToDecimalString(0.5)).toThrow('POSTING_AMOUNT_NOT_INTEGER')
    expect(() => centsToDecimalString(Number.NaN)).toThrow('POSTING_AMOUNT_NOT_INTEGER')
    expect(() => centsToDecimalString(Number.POSITIVE_INFINITY)).toThrow(
      'POSTING_AMOUNT_NOT_INTEGER'
    )
  })
})

describe('entityNameFor', () => {
  it('maps a bill to Bill and an expense to Purchase', () => {
    expect(entityNameFor('bill')).toBe('Bill')
    expect(entityNameFor('expense')).toBe('Purchase')
  })
})

describe('paymentTypeForAccount', () => {
  it('reads a credit card account as CreditCard', () => {
    expect(paymentTypeForAccount('Credit Card')).toBe('CreditCard')
    expect(paymentTypeForAccount('CreditCard')).toBe('CreditCard')
    expect(paymentTypeForAccount('credit card')).toBe('CreditCard')
    expect(paymentTypeForAccount('CREDIT_CARD')).toBe('CreditCard')
  })

  it('reads a bank account as Check', () => {
    expect(paymentTypeForAccount('Bank')).toBe('Check')
    expect(paymentTypeForAccount('Other Current Asset')).toBe('Check')
  })

  it('falls back to Check for an unknown type rather than refusing to post', () => {
    // Check is the neutral outcome: QuickBooks accepts it against a bank account, and being wrong
    // about the label is cosmetic, while stranding the row is not. The ACCOUNT itself is never
    // guessed, only the method label.
    expect(paymentTypeForAccount(null)).toBe('Check')
    expect(paymentTypeForAccount(undefined)).toBe('Check')
    expect(paymentTypeForAccount('')).toBe('Check')
  })
})

describe('buildBillPayload', () => {
  it('builds the vendor, dates, doc number, and the single categorized expense line', () => {
    expect(buildBillPayload(billInput())).toEqual({
      VendorRef: { value: '42' },
      TxnDate: '2026-07-27',
      DueDate: '2026-08-26',
      DocNumber: 'INV-1001',
      Line: [
        {
          Amount: '123.45',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: '7' } }
        }
      ]
    })
  })

  it('omits DueDate when the row has none, so QuickBooks applies the vendor terms', () => {
    const payload = buildBillPayload(billInput({ dueDate: null }))
    expect('DueDate' in payload).toBe(false)
  })

  it('omits DocNumber when there is no reference number', () => {
    const payload = buildBillPayload(billInput({ refNumber: null }))
    expect('DocNumber' in payload).toBe(false)
  })

  it('carries a memo as PrivateNote and as the line Description', () => {
    const payload = buildBillPayload(billInput({ memo: 'March service call' }))
    expect(payload.PrivateNote).toBe('March service call')
    expect(payload.Line[0].Description).toBe('March service call')
  })

  it('omits a blank memo rather than sending an empty string', () => {
    const payload = buildBillPayload(billInput({ memo: '   ' }))
    expect('PrivateNote' in payload).toBe(false)
    expect('Description' in payload.Line[0]).toBe(false)
  })

  it('refuses to build a bill from an expense row', () => {
    expect(() => buildBillPayload(billInput({ entryType: 'expense' }))).toThrow(
      'POSTING_WRONG_BUILDER'
    )
  })

  it('propagates the amount rules, so a bad amount never reaches QuickBooks', () => {
    expect(() => buildBillPayload(billInput({ amountCents: -1 }))).toThrow(
      'POSTING_AMOUNT_NEGATIVE'
    )
    expect(() => buildBillPayload(billInput({ amountCents: 1.5 }))).toThrow(
      'POSTING_AMOUNT_NOT_INTEGER'
    )
  })
})

describe('buildPurchasePayload', () => {
  it('puts the paying account on AccountRef and the vendor on EntityRef', () => {
    // The two refs mean different things and swapping them is the classic mistake: AccountRef is
    // WHAT PAID, EntityRef is WHO WAS PAID. The category account stays on the line.
    expect(buildPurchasePayload(expenseInput(), 'Bank')).toEqual({
      PaymentType: 'Check',
      AccountRef: { value: '35' },
      EntityRef: { value: '42', type: 'Vendor' },
      TxnDate: '2026-07-27',
      DocNumber: 'INV-1001',
      Line: [
        {
          Amount: '123.45',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: '7' } }
        }
      ]
    })
  })

  it('declares CreditCard when the paying account is a credit card', () => {
    expect(buildPurchasePayload(expenseInput(), 'Credit Card').PaymentType).toBe('CreditCard')
  })

  it('declares Check when the paying account is a bank account', () => {
    expect(buildPurchasePayload(expenseInput(), 'Bank').PaymentType).toBe('Check')
  })

  it('never carries a DueDate, because a purchase is already paid', () => {
    const payload = buildPurchasePayload(expenseInput({ dueDate: '2026-08-26' }), 'Bank')
    expect('DueDate' in payload).toBe(false)
  })

  it('refuses an expense that does not say which account paid it', () => {
    expect(() => buildPurchasePayload(expenseInput({ paidFromAccountId: null }), 'Bank')).toThrow(
      'POSTING_EXPENSE_NEEDS_ACCOUNT'
    )
    expect(() => buildPurchasePayload(expenseInput({ paidFromAccountId: '' }), 'Bank')).toThrow(
      'POSTING_EXPENSE_NEEDS_ACCOUNT'
    )
  })

  it('refuses to build a purchase from a bill row', () => {
    expect(() => buildPurchasePayload(expenseInput({ entryType: 'bill' }), 'Bank')).toThrow(
      'POSTING_WRONG_BUILDER'
    )
  })
})

describe('request paths carry the idempotency contract', () => {
  it('puts requestid and an explicit minorversion on the create path', () => {
    // Intuit's idempotency key is a QUERY PARAMETER on the create request, not a header and not a
    // body field. Replaying it returns the original response and creates nothing, which is the
    // entire reason a crash mid-batch is survivable.
    const path = createEntityPath('9341457604445280', 'Bill', 'req-123')
    expect(path).toBe(
      `/v3/company/9341457604445280/bill?minorversion=${QBO_MINOR_VERSION}&requestid=req-123`
    )
  })

  it('lowercases the resource for both entities', () => {
    expect(createEntityPath('1', 'Bill', 'r')).toContain('/bill?')
    expect(createEntityPath('1', 'Purchase', 'r')).toContain('/purchase?')
  })

  it('percent-encodes the realm id and the request id', () => {
    const path = createEntityPath('realm/1', 'Bill', 'a b&c')
    expect(path).toContain('/company/realm%2F1/')
    expect(path).toContain('requestid=a+b%26c')
  })

  it('pins an explicit minorversion on read and delete too, so response shapes stay stable', () => {
    expect(readEntityPath('1', 'Bill', '55')).toBe(
      `/v3/company/1/bill/55?minorversion=${QBO_MINOR_VERSION}`
    )
    expect(deleteEntityPath('1', 'Purchase')).toBe(
      `/v3/company/1/purchase?minorversion=${QBO_MINOR_VERSION}&operation=delete`
    )
  })

  it('never puts a requestid on a read or a delete, which are not creates', () => {
    expect(readEntityPath('1', 'Bill', '55')).not.toContain('requestid')
    expect(deleteEntityPath('1', 'Bill')).not.toContain('requestid')
  })
})
