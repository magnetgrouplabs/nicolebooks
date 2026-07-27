// test/helpers/qbo-reference-fixture.ts
//
// A frozen copy of the QuickBooks sandbox reference data, shaped exactly as the qbo cache serves it
// (QboReference). This is the ground truth from test-fixtures/MANIFEST.md, transcribed once so the
// reconciliation specs can run against the REAL candidate pool -- 44 expense accounts and 26
// vendors -- without a database, a network, or a live sandbox.
//
// WHY A COPY RATHER THAN THE LIVE CACHE. A matcher tested against three hand-picked names proves
// nothing: the whole risk in reconciliation is the runner-up you did not think of. Scoring every
// bill against the full chart of accounts is what makes 'Maintenance and Repair' vs 'Maintenance
// and Repairs', and the duplicated 'Equipment Rental', show up as failures rather than as surprises
// in production.
//
// TWO DETAILS THAT ARE LOAD-BEARING, NOT DECORATION:
//
//   1. `name` is the FULLY QUALIFIED path and `shortName` is the leaf, exactly as
//      src/main/qbo/reference.ts stores and derives them. Accounts 29 and 62 are both leaf-named
//      'Equipment Rental' and are told apart only by the path, which is the ambiguity the matcher
//      has to refuse to guess at.
//   2. The account hierarchy mirrors the sandbox company's chart of accounts (the Job Expenses,
//      Automobile, Legal & Professional Fees, Maintenance and Repair, Utilities and Insurance
//      parents). Ids and leaf names come straight from test-fixtures/manifest.json.
//
// Payment accounts are carried too, unused by the matcher on purpose: category candidates come from
// expenseAccounts alone, and a spec can assert that a Bank account is never offered as a category.

import type { QboReference, QboRefAccount, QboRefRecord } from '../../src/shared/ipc-contract'

/** The six vendors seeded for the fixture corpus (MANIFEST.md, "Vendors created by this agent"). */
export const SEEDED_VENDORS: readonly QboRefRecord[] = [
  { id: '58', name: 'Apex Plumbing Supply', active: true },
  { id: '59', name: 'Brightline Electric Supply', active: true },
  { id: '60', name: 'Metro Fuel Oil Corp', active: true },
  { id: '61', name: 'Cedar Lane Landscaping Supply', active: true },
  { id: '62', name: 'Northside Auto Parts', active: true },
  { id: '63', name: 'Pinnacle Office Supplies', active: true }
]

/**
 * The vendors the sandbox ships with. MANIFEST.md is explicit that none of them collide with the
 * six above, so a match against any of these is a false positive and the specs treat it as one.
 */
export const STOCK_VENDORS: readonly QboRefRecord[] = [
  { id: '30', name: "Bob's Burger Joint", active: true },
  { id: '31', name: 'Books by Bessie', active: true },
  { id: '32', name: 'Brosnahan Insurance Agency', active: true },
  { id: '33', name: 'Cal Telephone', active: true },
  { id: '34', name: "Chin's Gas and Oil", active: true },
  { id: '35', name: 'Computers by Jenni', active: true },
  { id: '36', name: "Diego's Road Warrior Bodyshop", active: true },
  { id: '37', name: 'Ellis Equipment Rental', active: true },
  { id: '38', name: 'Hall Properties', active: true },
  { id: '39', name: 'Hicks Hardware', active: true },
  { id: '40', name: 'Lee Advertising', active: true },
  { id: '41', name: 'Mahoney Mugs', active: true },
  { id: '42', name: 'Norton Lumber and Building Materials', active: true },
  { id: '43', name: 'PG&E', active: true },
  { id: '44', name: 'Pam Seitz', active: true },
  { id: '45', name: 'Robertson & Associates', active: true },
  { id: '46', name: 'Squeaky Kleen Car Wash', active: true },
  { id: '47', name: "Tania's Nursery", active: true },
  { id: '48', name: 'Tim Philip Masonry', active: true },
  { id: '49', name: 'Tony Rondonuwu', active: true }
]

/** Every vendor the cache would serve for the sandbox realm. */
export const FIXTURE_VENDORS: readonly QboRefRecord[] = [...SEEDED_VENDORS, ...STOCK_VENDORS]

/**
 * All 44 expense accounts, the only pool a category may resolve to. Sorted by fully qualified name,
 * which is also the order src/main/qbo/reference.ts reads them back in.
 */
export const FIXTURE_EXPENSE_ACCOUNTS: readonly QboRefAccount[] = [
  { id: '7', name: 'Advertising', shortName: 'Advertising', accountType: 'Expense', accountSubType: 'AdvertisingPromotional', active: true },
  { id: '55', name: 'Automobile', shortName: 'Automobile', accountType: 'Expense', accountSubType: 'Auto', active: true },
  { id: '56', name: 'Automobile:Fuel', shortName: 'Fuel', accountType: 'Expense', accountSubType: 'Auto', active: true },
  { id: '8', name: 'Bank Charges', shortName: 'Bank Charges', accountType: 'Expense', accountSubType: 'BankCharges', active: true },
  { id: '9', name: 'Commissions & fees', shortName: 'Commissions & fees', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '10', name: 'Dues & Subscriptions', shortName: 'Dues & Subscriptions', accountType: 'Expense', accountSubType: 'DuesSubscriptions', active: true },
  { id: '29', name: 'Equipment Rental', shortName: 'Equipment Rental', accountType: 'Expense', accountSubType: 'EquipmentRental', active: true },
  { id: '11', name: 'Insurance', shortName: 'Insurance', accountType: 'Expense', accountSubType: 'Insurance', active: true },
  { id: '57', name: 'Insurance:Workers Compensation', shortName: 'Workers Compensation', accountType: 'Expense', accountSubType: 'Insurance', active: true },
  { id: '58', name: 'Job Expenses', shortName: 'Job Expenses', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '59', name: 'Job Expenses:Cost of Labor', shortName: 'Cost of Labor', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '28', name: 'Job Expenses:Disposal Fees', shortName: 'Disposal Fees', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '62', name: 'Job Expenses:Equipment Rental', shortName: 'Equipment Rental', accountType: 'Expense', accountSubType: 'EquipmentRental', active: true },
  { id: '60', name: 'Job Expenses:Installation', shortName: 'Installation', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '63', name: 'Job Expenses:Job Materials', shortName: 'Job Materials', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '64', name: 'Job Expenses:Job Materials:Decks and Patios', shortName: 'Decks and Patios', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '65', name: 'Job Expenses:Job Materials:Fountain and Garden Lighting', shortName: 'Fountain and Garden Lighting', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '66', name: 'Job Expenses:Job Materials:Plants and Soil', shortName: 'Plants and Soil', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '78', name: 'Job Expenses:Job Materials:Purchases', shortName: 'Purchases', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '67', name: 'Job Expenses:Job Materials:Sprinklers and Drip Systems', shortName: 'Sprinklers and Drip Systems', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '61', name: 'Job Expenses:Maintenance and Repairs', shortName: 'Maintenance and Repairs', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '68', name: 'Job Expenses:Permits', shortName: 'Permits', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '12', name: 'Legal & Professional Fees', shortName: 'Legal & Professional Fees', accountType: 'Expense', accountSubType: 'LegalProfessionalFees', active: true },
  { id: '69', name: 'Legal & Professional Fees:Accounting', shortName: 'Accounting', accountType: 'Expense', accountSubType: 'LegalProfessionalFees', active: true },
  { id: '70', name: 'Legal & Professional Fees:Bookkeeper', shortName: 'Bookkeeper', accountType: 'Expense', accountSubType: 'LegalProfessionalFees', active: true },
  { id: '71', name: 'Legal & Professional Fees:Lawyer', shortName: 'Lawyer', accountType: 'Expense', accountSubType: 'LegalProfessionalFees', active: true },
  { id: '72', name: 'Maintenance and Repair', shortName: 'Maintenance and Repair', accountType: 'Expense', accountSubType: 'RepairMaintenance', active: true },
  { id: '73', name: 'Maintenance and Repair:Building Repairs', shortName: 'Building Repairs', accountType: 'Expense', accountSubType: 'RepairMaintenance', active: true },
  { id: '74', name: 'Maintenance and Repair:Computer Repairs', shortName: 'Computer Repairs', accountType: 'Expense', accountSubType: 'RepairMaintenance', active: true },
  { id: '75', name: 'Maintenance and Repair:Equipment Repairs', shortName: 'Equipment Repairs', accountType: 'Expense', accountSubType: 'RepairMaintenance', active: true },
  { id: '13', name: 'Meals and Entertainment', shortName: 'Meals and Entertainment', accountType: 'Expense', accountSubType: 'EntertainmentMeals', active: true },
  { id: '15', name: 'Office Expenses', shortName: 'Office Expenses', accountType: 'Expense', accountSubType: 'OfficeGeneralAdministrativeExpenses', active: true },
  { id: '16', name: 'Promotional', shortName: 'Promotional', accountType: 'Expense', accountSubType: 'AdvertisingPromotional', active: true },
  { id: '17', name: 'Rent or Lease', shortName: 'Rent or Lease', accountType: 'Expense', accountSubType: 'RentOrLeaseOfBuildings', active: true },
  { id: '19', name: 'Stationery & Printing', shortName: 'Stationery & Printing', accountType: 'Expense', accountSubType: 'OfficeGeneralAdministrativeExpenses', active: true },
  { id: '20', name: 'Supplies', shortName: 'Supplies', accountType: 'Expense', accountSubType: 'SuppliesMaterials', active: true },
  { id: '21', name: 'Taxes & Licenses', shortName: 'Taxes & Licenses', accountType: 'Expense', accountSubType: 'TaxesPaid', active: true },
  { id: '22', name: 'Travel', shortName: 'Travel', accountType: 'Expense', accountSubType: 'Travel', active: true },
  { id: '23', name: 'Travel Meals', shortName: 'Travel Meals', accountType: 'Expense', accountSubType: 'TravelMeals', active: true },
  { id: '88', name: 'Unapplied Cash Bill Payment Expense', shortName: 'Unapplied Cash Bill Payment Expense', accountType: 'Expense', accountSubType: 'UnappliedCashBillPaymentExpense', active: true },
  { id: '31', name: 'Uncategorized Expense', shortName: 'Uncategorized Expense', accountType: 'Expense', accountSubType: 'OtherMiscellaneousServiceCost', active: true },
  { id: '24', name: 'Utilities', shortName: 'Utilities', accountType: 'Expense', accountSubType: 'Utilities', active: true },
  { id: '76', name: 'Utilities:Gas and Electric', shortName: 'Gas and Electric', accountType: 'Expense', accountSubType: 'Utilities', active: true },
  { id: '77', name: 'Utilities:Telephone', shortName: 'Telephone', accountType: 'Expense', accountSubType: 'Utilities', active: true }
]

/** The Bank and Credit Card accounts. Never a category candidate; carried so a spec can prove it. */
export const FIXTURE_PAYMENT_ACCOUNTS: readonly QboRefAccount[] = [
  { id: '35', name: 'Checking', shortName: 'Checking', accountType: 'Bank', accountSubType: 'Checking', active: true },
  { id: '36', name: 'Savings', shortName: 'Savings', accountType: 'Bank', accountSubType: 'Savings', active: true },
  { id: '41', name: 'Mastercard', shortName: 'Mastercard', accountType: 'Credit Card', accountSubType: 'CreditCard', active: true },
  { id: '42', name: 'Visa', shortName: 'Visa', accountType: 'Credit Card', accountSubType: 'CreditCard', active: true }
]

/** The sandbox realm id from MANIFEST.md. Not a credential; it identifies the company. */
export const FIXTURE_REALM_ID = '9341457604445280'

/** The whole reference set, exactly as qbo:get-reference would serve it after a sync. */
export function fixtureReference(overrides: Partial<QboReference> = {}): QboReference {
  return {
    vendors: FIXTURE_VENDORS,
    expenseAccounts: FIXTURE_EXPENSE_ACCOUNTS,
    paymentAccounts: FIXTURE_PAYMENT_ACCOUNTS,
    items: [],
    syncedAt: '2026-07-27T12:00:00.000Z',
    ...overrides
  } as QboReference
}
