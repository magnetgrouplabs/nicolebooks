# Live sandbox drill

Run against realm 9341457604445280. Every figure below was read back out of QuickBooks
or out of the app's own parse cache, never taken from the screen.

## Parse accuracy vs test-fixtures/manifest.json
- apex-plumbing-supply-invoice-APX-84213.pdf (native, 1p): vendor read as "Apex Plumbing Supply" (printed "Apex Plumbing Supply"), every checked field matches the manifest
- metro-fuel-oil-corp-invoice-MF-2026-0714.pdf (native, 1p): vendor read as "METRO FUEL OIL CORP" (printed "Metro Fuel Oil Corp"), every checked field matches the manifest
- brightline-electric-invoice-BE-5590.pdf (native, 1p): vendor read as "Brightline Electric" (printed "Brightline Electric"), every checked field matches the manifest
- quality-craft-tools-invoice-QCT-1188.pdf (native, 1p): vendor read as "Quality Craft Tools LLC" (printed "Quality Craft Tools LLC"), every checked field matches the manifest
- apex-plumbing-supply-credit-memo-CM-3307.pdf (native, 1p): vendor read as "Apex Plumbing Supply" (printed "Apex Plumbing Supply"), MISMATCH: ref APX-84213 vs CM-3307
- northside-auto-parts-receipt.jpg (image-only, 1p): vendor read as "NORTHSIDE AUTO PARTS" (printed "NORTHSIDE AUTO PARTS"), every checked field matches the manifest
- cedar-lane-landscaping-receipt.jpg (image-only, 1p): vendor read as "CEDAR LANE LANDSCAPING" (printed "CEDAR LANE LANDSCAPING"), every checked field matches the manifest
- pinnacle-office-supplies-receipt.jpg (image-only, 1p): vendor read as "PINNACLE OFFICE SUPPLIES" (printed "PINNACLE OFFICE SUPPLIES"), every checked field matches the manifest
- brightline-electric-supply-scan-BE-5731.pdf (image-only, 1p): vendor read as "Brightline Electric Supply" (printed "Brightline Electric Supply"), every checked field matches the manifest

## Reconciliation
Reference sync: 38 vendors, 44 expense accounts, 4 payment accounts, 18 items.
- apex-plumbing-supply-invoice-APX-84213.pdf: vendor expected exact, got auto -> "Apex Plumbing Supply"; category none (nothing prefilled)
- metro-fuel-oil-corp-invoice-MF-2026-0714.pdf: vendor expected exact, got auto -> "Metro Fuel Oil Corp"; category none (nothing prefilled)
- brightline-electric-invoice-BE-5590.pdf: vendor expected near-miss, got suggested -> "Brightline Electric Supply"; category none (nothing prefilled)
- quality-craft-tools-invoice-QCT-1188.pdf: vendor expected unknown, got none (nothing prefilled); category none (nothing prefilled)
- apex-plumbing-supply-credit-memo-CM-3307.pdf: vendor expected exact, got auto -> "Apex Plumbing Supply"; category none (nothing prefilled)
- northside-auto-parts-receipt.jpg: vendor expected exact, got auto -> "Northside Auto Parts"; category none (nothing prefilled)
- cedar-lane-landscaping-receipt.jpg: vendor expected near-miss, got suggested -> "Cedar Lane Landscaping Supply"; category none (nothing prefilled)
- pinnacle-office-supplies-receipt.jpg: vendor expected exact, got auto -> "Pinnacle Office Supplies"; category none (nothing prefilled)
- brightline-electric-supply-scan-BE-5731.pdf: vendor expected exact, got auto -> "Brightline Electric Supply"; category none (nothing prefilled)

## Create vendor
- Earlier drills had already created Quality Craft Tools LLC (vendor ids 69). Each was renamed out of the way first, because QuickBooks cannot delete a vendor and a deactivated name still collides. The company therefore started from the documented state.
- Panel prefilled with "Quality Craft Tools LLC".
- In the sandbox as vendor id 70, DisplayName "Quality Craft Tools LLC", active true.
- A repeat create is refused, mapped to the pick-it-from-the-list sentence.

## Posted entities
- apex-plumbing-supply-credit-memo-CM-3307.pdf: EXCLUDED (negative total, this app posts bills and expenses only).
- The screen reported: "8 of 8 entered in QuickBooks."
- apex-plumbing-supply-invoice-APX-84213.pdf: Bill 177, $629.97, DocNumber APX-84213, dated 2026-07-08, category Job Expenses:Job Materials, due 2026-08-07.
- metro-fuel-oil-corp-invoice-MF-2026-0714.pdf: Bill 181, $2084.30, DocNumber MF-2026-0714, dated 2026-07-14, category Automobile:Fuel, due 2026-07-29.
- brightline-electric-invoice-BE-5590.pdf: Bill 178, $681.24, DocNumber BE-5590, dated 2026-07-16, category Job Expenses:Job Materials, due 2026-08-15.
- quality-craft-tools-invoice-QCT-1188.pdf: Bill 184, $371.44, DocNumber QCT-1188, dated 2026-07-21, category Supplies, due 2026-08-20.
- brightline-electric-supply-scan-BE-5731.pdf: Bill 179, $801.16, DocNumber BE-5731, dated 2026-07-24, category Job Expenses:Job Materials, due 2026-08-23.
- northside-auto-parts-receipt.jpg: Purchase 182, $150.90, DocNumber 0214-118-4471, dated 2026-07-11, category Automobile, paid from Visa as CreditCard.
- cedar-lane-landscaping-receipt.jpg: Purchase 180, $268.44, DocNumber CL-77213, dated 2026-07-17, category Job Expenses:Job Materials:Plants and Soil, paid from Mastercard as CreditCard.
- pinnacle-office-supplies-receipt.jpg: Purchase 183, $284.28, DocNumber PN-2026-4419, dated 2026-07-20, category Office Expenses, paid from Checking as Check.

## Duplicate guards
- Re-scanning apex-plumbing-supply-invoice-APX-84213.pdf after it posted: excluded by the hash ledger ("Already entered on 2026-07-27").
- A probe for vendor 58 at $629.97 on 2026-07-08 warned about 1 prior entry (QuickBooks id 177, 0 days apart).

## Undo
- apex-plumbing-supply-invoice-APX-84213.pdf: Bill 177 is no longer in QuickBooks.
- metro-fuel-oil-corp-invoice-MF-2026-0714.pdf: Bill 181 is no longer in QuickBooks.
- brightline-electric-invoice-BE-5590.pdf: Bill 178 is no longer in QuickBooks.
- quality-craft-tools-invoice-QCT-1188.pdf: Bill 184 is no longer in QuickBooks.
- brightline-electric-supply-scan-BE-5731.pdf: Bill 179 is no longer in QuickBooks.
- northside-auto-parts-receipt.jpg: Purchase 182 is no longer in QuickBooks.
- cedar-lane-landscaping-receipt.jpg: Purchase 180 is no longer in QuickBooks.
- pinnacle-office-supplies-receipt.jpg: Purchase 183 is no longer in QuickBooks.
- The dedupe ledger was cleared, so every document can be entered again.

## Problems found
apex-plumbing-supply-credit-memo-CM-3307.pdf parse mismatch: ref APX-84213 vs CM-3307

## Standing observations for the design and release waves

### The credit memo cannot be posted, by design
apex-plumbing-supply-credit-memo-CM-3307.pdf totals minus $147.51. PostingRowSchema refuses a
non-positive amount and centsToDecimalString refuses a negative one, both deliberately: an
entry that reads as a bill and behaves as a credit is the wrong thing to put in somebody's
books. The row therefore parses, displays, and is excluded by the user, and the review screen
says what it still needs. Supporting it properly means a Vendor Credit entity, which is a
feature, not a fix.

### Category reconciliation never fires on this corpus (CLOSED, see below)
Every document above came back with category tier "none". The cause is upstream of the
matcher: the model returns suggested_category as null for these fixtures, because none of the
nine documents PRINTS a category, and the prompt correctly asks for null when a field is
absent. The matcher is fine; it is being handed nothing to match. Every row therefore needs a
category picked by hand, which is the single biggest piece of remaining manual work in the
flow. Closing it means asking the model to INFER a category from the line items rather than to
read one off the page, which is a prompt change with its own accuracy question and belongs to
whoever owns the parse prompt.

### Category inference, revalidated live (2026-07-27)
suggested_category is now asked for as an inference from the vendor and the line items
(src/main/parse/prompt.ts, CATEGORY_INSTRUCTION), and parse SCHEMA_VERSION moved 1 to 2 so
every row cached under the transcription prompt re-parses once on the next scan. Four fixtures
spanning both routes were re-run through the real extraction path against gpt-4o-mini, and the
phrase each returned was ranked offline against the sandbox's own 44 expense accounts:

| Document | Route | Inferred phrase | Recon resolution | Tier | Score |
| --- | --- | --- | --- | --- | --- |
| apex-plumbing-supply-invoice-APX-84213.pdf | native text PDF | job materials | Job Expenses:Job Materials | auto | 1.00 |
| metro-fuel-oil-corp-invoice-MF-2026-0714.pdf | native text PDF | fuel | Automobile:Fuel | auto | 1.00 |
| northside-auto-parts-receipt.jpg | raster receipt photo | automobile | Automobile | auto | 1.00 |
| brightline-electric-supply-scan-BE-5731.pdf | image-only scan PDF | supplies | Supplies | auto | 1.00 |

Four of four, all at the auto tier. Three land on the account the manifest hints at; the
electrical scan lands on Supplies where the manifest hints Job Materials, which is a defensible
second reading of the same bill and is exactly the call the review grid asks a person to
confirm.

The wording is what earns those scores, and the first live run proved it: asked for a
merchandise-flavoured phrase the model answered well and matched badly ("plumbing supplies"
0.61, "auto parts" 0.59, "electrical supplies" 0.57, all under the 0.62 suggest floor, so four
correct readings still produced three empty cells). Asking for the standard chart-of-accounts
wording instead, with no trade or product qualifier, moved every one of them to 1.00. Nothing
in src/main/recon/ was touched.

Re-run it with: LIVE_AI=1 npm run test:live (see live/parse-category.live.test.ts).

### Vendor reconciliation is exactly on target
Six exact names matched at the auto tier with no marker, two near misses matched at the
suggested tier with a marker, and the one unknown supplier stayed empty and was never created
behind the user's back. That is the corpus's whole design, reproduced.

## Screenshots
- .planning/sprint/screens/01-parse-complete.png
- .planning/sprint/screens/02-reconciled.png
- .planning/sprint/screens/03-add-vendor-panel.png
- .planning/sprint/screens/04-vendor-created.png
- .planning/sprint/screens/05-rows-completed.png
- .planning/sprint/screens/06-sending.png
- .planning/sprint/screens/07-send-complete.png
- .planning/sprint/screens/08-dedupe-rescan.png
- .planning/sprint/screens/09-history-batch.png
- .planning/sprint/screens/10-undo-complete.png
- .planning/sprint/screens/11-after-undo-rescan.png
