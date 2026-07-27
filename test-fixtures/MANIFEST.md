# Test Fixture Manifest

Ground truth for the NicoleBooks test corpus in `test-fixtures/bills/`, plus the
QuickBooks Online **sandbox** reference data these fixtures are meant to reconcile
against. This file is the verification key for the end-to-end integration agent.

- Sandbox realm: `9341457604445280`
- Sandbox base URL: `https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280` (minorversion 75)
- Corpus generated: 2026-07-27
- All money below is in **cents**, and `subtotal + tax = total` exactly for every document.
- Every printed dollar figure in the documents was rendered from these same cent values,
  so the manifest and the documents cannot drift apart.
- A machine readable copy of everything here lives in `test-fixtures/manifest.json`.

## Corpus at a glance

| File | Kind | Printed vendor | Expected vendor match | Ref | Date | Total |
|------|------|----------------|-----------------------|-----|------|-------|
| `apex-plumbing-supply-invoice-APX-84213.pdf` | text-pdf | Apex Plumbing Supply | exact -> Apex Plumbing Supply (id 58) | APX-84213 | 2026-07-08 | $629.97 |
| `metro-fuel-oil-corp-invoice-MF-2026-0714.pdf` | text-pdf | Metro Fuel Oil Corp | exact -> Metro Fuel Oil Corp (id 60) | MF-2026-0714 | 2026-07-14 | $2,084.30 |
| `brightline-electric-invoice-BE-5590.pdf` | text-pdf | Brightline Electric | fuzzy -> Brightline Electric Supply (id 59) | BE-5590 | 2026-07-16 | $681.24 |
| `quality-craft-tools-invoice-QCT-1188.pdf` | text-pdf | Quality Craft Tools LLC | no match (must NOT be created silently) | QCT-1188 | 2026-07-21 | $371.44 |
| `apex-plumbing-supply-credit-memo-CM-3307.pdf` | credit memo (text-pdf) | Apex Plumbing Supply | exact -> Apex Plumbing Supply (id 58) | CM-3307 | 2026-07-23 | -$147.51 |
| `northside-auto-parts-receipt.jpg` | raster receipt | NORTHSIDE AUTO PARTS | exact -> Northside Auto Parts (id 62) | 0214-118-4471 | 2026-07-11 | $150.90 |
| `cedar-lane-landscaping-receipt.jpg` | raster receipt | CEDAR LANE LANDSCAPING | fuzzy -> Cedar Lane Landscaping Supply (id 61) | CL-77213 | 2026-07-17 | $268.44 |
| `pinnacle-office-supplies-receipt.jpg` | raster receipt | PINNACLE OFFICE SUPPLIES | exact -> Pinnacle Office Supplies (id 63) | PN-2026-4419 | 2026-07-20 | $284.28 |
| `brightline-electric-supply-scan-BE-5731.pdf` | image-pdf | Brightline Electric Supply | exact -> Brightline Electric Supply (id 59) | BE-5731 | 2026-07-24 | $801.16 |

## What each fixture exercises

| File | Exercises |
|------|-----------|
| `apex-plumbing-supply-invoice-APX-84213.pdf` | Happy path: digital PDF text extraction, exact vendor match, Bill creation |
| `metro-fuel-oil-corp-invoice-MF-2026-0714.pdf` | Fractional unit prices (4 decimal places per gallon) and a banner style layout |
| `brightline-electric-invoice-BE-5590.pdf` | Fuzzy vendor match: printed name is a prefix of the sandbox vendor name |
| `quality-craft-tools-invoice-QCT-1188.pdf` | Unknown vendor. The app must surface it for a decision and must never create the vendor silently |
| `apex-plumbing-supply-credit-memo-CM-3307.pdf` | Sign handling: every amount and the total are negative |
| `northside-auto-parts-receipt.jpg` | Vision route on a raster receipt, exact match, paid by credit card so it is an Expense candidate |
| `cedar-lane-landscaping-receipt.jpg` | Vision route plus fuzzy match (printed name drops the trailing word "Supply") |
| `pinnacle-office-supplies-receipt.jpg` | Vision route, exact match, paid by debit so "paid from" should resolve to a Bank account |
| `brightline-electric-supply-scan-BE-5731.pdf` | PDF with no text layer. Text extraction must come back empty and route the page to the vision model |

Note on near duplicates: `BE-5590` and `BE-5731` are two different Brightline
documents with different reference numbers, dates, and totals. They must both post.
They are in the corpus specifically so a dedupe rule that keys only on vendor does
not collapse them.

## Per document ground truth

### `bills/apex-plumbing-supply-invoice-APX-84213.pdf`

| Field | Value |
|-------|-------|
| Document kind | text-pdf |
| Document type | invoice |
| Vendor as printed | Apex Plumbing Supply |
| Expected sandbox vendor | Apex Plumbing Supply |
| Expected sandbox vendor id | 58 |
| Match type | exact |
| Reference number | APX-84213 |
| Document date | 2026-07-08 |
| Due date | 2026-08-07 |
| Terms | Net 30 |
| Subtotal (cents) | 57995 ($579.95) |
| Tax (cents) | 5002 ($50.02) |
| **Total (cents)** | **62997** ($629.97) |
| Line count | 4 |
| Expected transaction type | Bill |
| Suggested expense account | Job Materials (63) |
| Expected "paid from" | n/a, this is a Bill |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| 1/2 in. Copper Pipe Type L, 10 ft joint | 12 | 2840 | 34080 |
| 3/4 in. Brass Ball Valve, full port | 8 | 1975 | 15800 |
| PVC Primer and Cement Kit, 8 oz | 3 | 1425 | 4275 |
| Pipe Hanger Strap, 25 ft roll | 4 | 960 | 3840 |

### `bills/metro-fuel-oil-corp-invoice-MF-2026-0714.pdf`

| Field | Value |
|-------|-------|
| Document kind | text-pdf |
| Document type | invoice |
| Vendor as printed | Metro Fuel Oil Corp |
| Expected sandbox vendor | Metro Fuel Oil Corp |
| Expected sandbox vendor id | 60 |
| Match type | exact |
| Reference number | MF-2026-0714 |
| Document date | 2026-07-14 |
| Due date | 2026-07-29 |
| Terms | Net 15 |
| Subtotal (cents) | 191880 ($1,918.80) |
| Tax (cents) | 16550 ($165.50) |
| **Total (cents)** | **208430** ($2,084.30) |
| Line count | 3 |
| Expected transaction type | Bill |
| Suggested expense account | Fuel (56) |
| Expected "paid from" | n/a, this is a Bill |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| No. 2 Heating Oil, delivered | 400.0 gal | 349 | 139560 |
| Off-Road Diesel, tank fill | 120.0 gal | 399 | 47820 |
| After-hours delivery surcharge | 1 | 4500 | 4500 |

### `bills/brightline-electric-invoice-BE-5590.pdf`

| Field | Value |
|-------|-------|
| Document kind | text-pdf |
| Document type | invoice |
| Vendor as printed | Brightline Electric |
| Expected sandbox vendor | Brightline Electric Supply |
| Expected sandbox vendor id | 59 |
| Match type | near-miss |
| Reference number | BE-5590 |
| Document date | 2026-07-16 |
| Due date | 2026-08-15 |
| Terms | Net 30 |
| Subtotal (cents) | 62715 ($627.15) |
| Tax (cents) | 5409 ($54.09) |
| **Total (cents)** | **68124** ($681.24) |
| Line count | 4 |
| Expected transaction type | Bill |
| Suggested expense account | Job Materials (63) |
| Expected "paid from" | n/a, this is a Bill |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| 12/2 NM-B Romex Wire, 250 ft coil | 2 | 11850 | 23700 |
| 20A Single Pole Breaker | 10 | 1230 | 12300 |
| 4 in. Square Junction Box | 15 | 385 | 5775 |
| LED Shop Fixture, 4 ft | 6 | 3490 | 20940 |

### `bills/quality-craft-tools-invoice-QCT-1188.pdf`

| Field | Value |
|-------|-------|
| Document kind | text-pdf |
| Document type | invoice |
| Vendor as printed | Quality Craft Tools LLC |
| Expected sandbox vendor | none |
| Expected sandbox vendor id | n/a, unknown vendor |
| Match type | unknown |
| Reference number | QCT-1188 |
| Document date | 2026-07-21 |
| Due date | 2026-08-20 |
| Terms | Net 30 |
| Subtotal (cents) | 34195 ($341.95) |
| Tax (cents) | 2949 ($29.49) |
| **Total (cents)** | **37144** ($371.44) |
| Line count | 3 |
| Expected transaction type | Bill |
| Suggested expense account | Supplies (20) |
| Expected "paid from" | n/a, this is a Bill |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| 18V Cordless Impact Driver Kit | 1 | 18900 | 18900 |
| Contractor Tool Bag, 18 in. | 2 | 4250 | 8500 |
| Bi-Metal Hole Saw Set, 9 piece | 1 | 6795 | 6795 |

### `bills/apex-plumbing-supply-credit-memo-CM-3307.pdf`

| Field | Value |
|-------|-------|
| Document kind | credit memo (text-pdf) |
| Document type | credit-memo |
| Vendor as printed | Apex Plumbing Supply |
| Expected sandbox vendor | Apex Plumbing Supply |
| Expected sandbox vendor id | 58 |
| Match type | exact |
| Reference number | CM-3307 |
| Document date | 2026-07-23 |
| Due date | n/a |
| Terms | Credit applied to account |
| Subtotal (cents) | -13580 (-$135.80) |
| Tax (cents) | -1171 (-$11.71) |
| **Total (cents)** | **-14751** (-$147.51) |
| Line count | 2 |
| Expected transaction type | Bill (negative) or Vendor Credit |
| Suggested expense account | Job Materials (63) |
| Expected "paid from" | n/a, this is a Bill |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| 3/4 in. Brass Ball Valve, returned unused | -4 | 1975 | -7900 |
| 1/2 in. Copper Pipe Type L, damaged in transit | -2 | 2840 | -5680 |

### `bills/northside-auto-parts-receipt.jpg`

| Field | Value |
|-------|-------|
| Document kind | raster receipt |
| Document type | receipt |
| Vendor as printed | NORTHSIDE AUTO PARTS |
| Expected sandbox vendor | Northside Auto Parts |
| Expected sandbox vendor id | 62 |
| Match type | exact |
| Reference number | 0214-118-4471 |
| Document date | 2026-07-11 |
| Due date | n/a |
| Terms | n/a |
| Subtotal (cents) | 13892 ($138.92) |
| Tax (cents) | 1198 ($11.98) |
| **Total (cents)** | **15090** ($150.90) |
| Line count | 4 |
| Expected transaction type | Expense (Purchase) |
| Suggested expense account | Automobile (55) |
| Expected "paid from" | Visa (42), Credit Card |
| Tender printed on document | VISA ****4412 |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| AC DELCO OIL FILTER PF63 | 3 | 1149 | 3447 |
| MOBIL 1 5W-30 5QT | 2 | 3299 | 6598 |
| WIPER BLADE 22IN | 2 | 1499 | 2998 |
| SHOP TOWELS 50CT | 1 | 849 | 849 |

### `bills/cedar-lane-landscaping-receipt.jpg`

| Field | Value |
|-------|-------|
| Document kind | raster receipt |
| Document type | receipt |
| Vendor as printed | CEDAR LANE LANDSCAPING |
| Expected sandbox vendor | Cedar Lane Landscaping Supply |
| Expected sandbox vendor id | 61 |
| Match type | near-miss |
| Reference number | CL-77213 |
| Document date | 2026-07-17 |
| Due date | n/a |
| Terms | n/a |
| Subtotal (cents) | 24713 ($247.13) |
| Tax (cents) | 2131 ($21.31) |
| **Total (cents)** | **26844** ($268.44) |
| Line count | 4 |
| Expected transaction type | Expense (Purchase) |
| Suggested expense account | Plants and Soil (66) |
| Expected "paid from" | Mastercard (41), Credit Card |
| Tender printed on document | MASTERCARD ****8830 |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| PREMIUM TOPSOIL 40LB BAG | 20 | 479 | 9580 |
| HARDWOOD MULCH 2CU FT | 15 | 549 | 8235 |
| LANDSCAPE FABRIC 3X50 | 2 | 2199 | 4398 |
| EDGING STAKES 10PK | 4 | 625 | 2500 |

### `bills/pinnacle-office-supplies-receipt.jpg`

| Field | Value |
|-------|-------|
| Document kind | raster receipt |
| Document type | receipt |
| Vendor as printed | PINNACLE OFFICE SUPPLIES |
| Expected sandbox vendor | Pinnacle Office Supplies |
| Expected sandbox vendor id | 63 |
| Match type | exact |
| Reference number | PN-2026-4419 |
| Document date | 2026-07-20 |
| Due date | n/a |
| Terms | n/a |
| Subtotal (cents) | 26171 ($261.71) |
| Tax (cents) | 2257 ($22.57) |
| **Total (cents)** | **28428** ($284.28) |
| Line count | 5 |
| Expected transaction type | Expense (Purchase) |
| Suggested expense account | Office Expenses (15) |
| Expected "paid from" | Checking (35), Bank |
| Tender printed on document | DEBIT ****2091 |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| COPY PAPER 8.5X11 10RM CASE | 2 | 4699 | 9398 |
| TONER CARTRIDGE HP 26A BLK | 1 | 8999 | 8999 |
| FILE FOLDERS LETTER 100CT | 3 | 1749 | 5247 |
| PENS BLACK 12PK | 2 | 699 | 1398 |
| STICKY NOTES 3X3 12PK | 1 | 1129 | 1129 |

### `bills/brightline-electric-supply-scan-BE-5731.pdf`

| Field | Value |
|-------|-------|
| Document kind | image-pdf |
| Document type | invoice |
| Vendor as printed | Brightline Electric Supply |
| Expected sandbox vendor | Brightline Electric Supply |
| Expected sandbox vendor id | 59 |
| Match type | exact |
| Reference number | BE-5731 |
| Document date | 2026-07-24 |
| Due date | 2026-08-23 |
| Terms | Net 30 |
| Subtotal (cents) | 73755 ($737.55) |
| Tax (cents) | 6361 ($63.61) |
| **Total (cents)** | **80116** ($801.16) |
| Line count | 4 |
| Expected transaction type | Bill |
| Suggested expense account | Job Materials (63) |
| Expected "paid from" | n/a, this is a Bill |

Line items:

| Description | Qty | Unit (cents) | Amount (cents) |
|-------------|-----|--------------|----------------|
| 200A Meter Socket, ringless | 1 | 21400 | 21400 |
| 2 in. EMT Conduit, 10 ft length | 12 | 2735 | 32820 |
| 1 in. EMT Compression Connector | 25 | 415 | 10375 |
| Ground Rod, 8 ft copper clad | 4 | 2290 | 9160 |

## Sandbox state

Everything below lives in QuickBooks Online sandbox realm `9341457604445280`.

### Vendors created by this agent

| QBO Id | DisplayName | Action |
|--------|-------------|--------|
| 58 | Apex Plumbing Supply | created |
| 59 | Brightline Electric Supply | created |
| 60 | Metro Fuel Oil Corp | created |
| 61 | Cedar Lane Landscaping Supply | created |
| 62 | Northside Auto Parts | created |
| 63 | Pinnacle Office Supplies | created |

No vendor named "Quality Craft Tools LLC" exists in the sandbox. That absence is
deliberate: it is the fixture that proves the app never creates a vendor on its own.

### Bank accounts (found, not created)

| QBO Id | Name | AccountType | AccountSubType |
|--------|------|-------------|----------------|
| 35 | Checking | Bank | Checking |
| 36 | Savings | Bank | Savings |

### Credit card accounts (found, not created)

| QBO Id | Name | AccountType | AccountSubType |
|--------|------|-------------|----------------|
| 41 | Mastercard | Credit Card | CreditCard |
| 42 | Visa | Credit Card | CreditCard |

The sandbox already shipped with two Bank accounts and two Credit Card accounts, so
no "Company Visa" account was created. "Paid from" testing uses Visa (42),
Mastercard (41), and Checking (35).

### Expense accounts (found, not created)

| QBO Id | Name | AccountSubType |
|--------|------|----------------|
| 69 | Accounting | LegalProfessionalFees |
| 7 | Advertising | AdvertisingPromotional |
| 55 | Automobile | Auto |
| 8 | Bank Charges | BankCharges |
| 70 | Bookkeeper | LegalProfessionalFees |
| 73 | Building Repairs | RepairMaintenance |
| 9 | Commissions & fees | OtherMiscellaneousServiceCost |
| 74 | Computer Repairs | RepairMaintenance |
| 59 | Cost of Labor | OtherMiscellaneousServiceCost |
| 64 | Decks and Patios | SuppliesMaterials |
| 28 | Disposal Fees | OtherMiscellaneousServiceCost |
| 10 | Dues & Subscriptions | DuesSubscriptions |
| 62 | Equipment Rental | EquipmentRental |
| 29 | Equipment Rental | EquipmentRental |
| 75 | Equipment Repairs | RepairMaintenance |
| 65 | Fountain and Garden Lighting | SuppliesMaterials |
| 56 | Fuel | Auto |
| 76 | Gas and Electric | Utilities |
| 60 | Installation | OtherMiscellaneousServiceCost |
| 11 | Insurance | Insurance |
| 58 | Job Expenses | OtherMiscellaneousServiceCost |
| 63 | Job Materials | SuppliesMaterials |
| 71 | Lawyer | LegalProfessionalFees |
| 12 | Legal & Professional Fees | LegalProfessionalFees |
| 72 | Maintenance and Repair | RepairMaintenance |
| 61 | Maintenance and Repairs | OtherMiscellaneousServiceCost |
| 13 | Meals and Entertainment | EntertainmentMeals |
| 15 | Office Expenses | OfficeGeneralAdministrativeExpenses |
| 68 | Permits | OtherMiscellaneousServiceCost |
| 66 | Plants and Soil | SuppliesMaterials |
| 16 | Promotional | AdvertisingPromotional |
| 78 | Purchases | SuppliesMaterials |
| 17 | Rent or Lease | RentOrLeaseOfBuildings |
| 67 | Sprinklers and Drip Systems | SuppliesMaterials |
| 19 | Stationery & Printing | OfficeGeneralAdministrativeExpenses |
| 20 | Supplies | SuppliesMaterials |
| 21 | Taxes & Licenses | TaxesPaid |
| 77 | Telephone | Utilities |
| 22 | Travel | Travel |
| 23 | Travel Meals | TravelMeals |
| 88 | Unapplied Cash Bill Payment Expense | UnappliedCashBillPaymentExpense |
| 31 | Uncategorized Expense | OtherMiscellaneousServiceCost |
| 24 | Utilities | Utilities |
| 57 | Workers Compensation | Insurance |

Note: "Equipment Rental" appears twice (ids 29 and 62) in the stock sandbox data.
That is a useful ambiguity case for the account matcher.

### Pre-existing sandbox vendors

The sandbox ships with 26 vendors of its own (Bob's Burger Joint,
Books by Bessie, Hicks Hardware, Norton Lumber and Building Materials, and so on).
None of them collide with the six seeded above, so a match against any stock vendor
name is a false positive.

## How to re-verify

Re-run the reference queries against the sandbox:

```
GET /v3/company/9341457604445280/query?query=SELECT * FROM Vendor&minorversion=75
GET /v3/company/9341457604445280/query?query=SELECT * FROM Account WHERE AccountType IN ('Expense','Bank','Credit Card')&minorversion=75
```

The fixture documents are deterministic byte-for-byte inputs, so any change in
parsed totals is a regression in the parser, not in the corpus.
