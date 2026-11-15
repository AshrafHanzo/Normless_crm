# Vendors, vendor orders and vendor payments — design

Status: **draft v2 — answers folded in, mockup next** (2026-11-15). Nothing built yet.

Decisions from review:

- Myxture POD stays its own flow, untouched.
- Quotes and bills are **GST-inclusive**. Nothing is pushed to the GST purchase register; that is
  still entered by hand under Invoices.
- No approval step: whoever is given `can_record_vendor_payments` records payments directly.
- The vendor link is read-only **except** that the vendor can upload their invoices (in v1).
- Payment terms differ per vendor and per agreement, so the plan is set per order (a vendor can
  keep a default template to start from).

Replaces the vendor-payments Excel sheet. One module shared by Normless and Crewfit, built by
growing the existing Crewfit **Vendor Orders** page rather than starting over.

---

## 1. What we're solving

Today, per vendor, the sheet tracks:

- the bulk order and the quotation it was priced from,
- part payments made against it (EMI-style: advance, then instalments),
- the bank reference / UTR for each payment,
- what has been received and what is still pending.

The CRM already has part of this — `crewfit_vendor_orders` (items by product / GSM / colour / size,
rate, delivery date, a PDF and WhatsApp text for the vendor) — but payment is a single
`Paid / Not Paid` flag, receipt is a single status, there are no quotations, and it is Crewfit-only.

## 2. Scope

**In v1**

1. **Vendor master** — one list for both brands, with contact, GST, and bank details.
2. **Quotations** — upload the vendor's quote (PDF / image), with amount and validity; accept one
   to turn it into an order.
3. **Vendor orders** — tagged **Normless** or **Crewfit**; items as today.
4. **Payment plan** — the EMI schedule agreed with the vendor (e.g. 30% advance, 40% on
   dispatch, 30% after QC), each instalment with a due date.
5. **Payments** — every part payment with date, amount, mode, **UTR / bank reference**, and an
   optional proof screenshot.
6. **Receipts (goods in)** — record each delivery against the order's lines, so "received" and
   "yet to receive" are per colour / size, not a single status.
7. **Vendor link** — a private share link the vendor opens without logging in to see their
   profile, orders, receipts, payments with references, and balance.
8. **Import** of the current Excel sheet.

9. **Vendor invoice upload** through the link (§7).

**Later (v2)** — auto-match payments to bank statement lines; payment reminders on WhatsApp.

**Out of scope** — Myxture POD stays its own flow (it is per-order print-on-demand, not quoted
bulk). *Open question 1.*

## 3. Where it lives

A shared **Purchasing** section in the sidebar, shown under both brands — the same way **Team**
is shared today:

```
PURCHASING
  Vendors          /vendors
  Vendor Orders    /vendor-orders      (brand filter: All · Normless · Crewfit)
  Vendor Payments  /vendor-payments
```

The old `/crewfit/vendor-orders` route redirects to `/vendor-orders?brand=crewfit`. The list
defaults to the brand you are currently in, with one click to see both.

## 4. Data model

```
vendors 1──* vendor_quotations
   │            │ (accepted → becomes)
   │            ▼
   └──────1──* vendor_orders 1──* vendor_order_instalments   (the plan)
                    │      1──* vendor_receipts 1──* receipt lines
                    │
vendors 1──* vendor_payments *──* vendor_orders              (via allocations)
```

### `vendors` (replaces `crewfit_vendors`)

| column | notes |
|---|---|
| name, contact_person, phone, whatsapp, email | phone already used for the WhatsApp text |
| address, city, state | |
| gstin, pan | links to `gst_suppliers` when the GSTIN matches |
| bank_account_name, bank_account_no, ifsc, bank_name, upi_id | shown on the payment form so whoever pays doesn't hunt for them |
| categories | e.g. blanks, printing, embroidery, packaging, labels |
| brands | which brands use them: `{normless, crewfit}` — informational only |
| payment_terms | free text default, e.g. "30% advance, balance on delivery" |
| default_plan | optional instalment template copied into new orders |
| notes | internal, never shown on the vendor link |
| portal_token, portal_enabled, portal_created_at, portal_last_seen_at | see §7 |
| active | archived vendors drop out of pick-lists, history stays |

### `vendor_quotations`

| column | notes |
|---|---|
| vendor_id, brand | |
| quote_no, quote_date, valid_until | as printed on the vendor's quote |
| title | e.g. "Oversized tees – Dec drop" |
| amount, gst_included | |
| file_path, file_name, mime | stored under `server/storage/vendors/`, **not** `/uploads` (that folder is public) |
| status | Received · Accepted · Rejected · Expired |
| order_id | set when accepted |

Several quotes for the same job (from different vendors, or revisions) sit side by side so they
can be compared before accepting one.

### `vendor_orders` (replaces `crewfit_vendor_orders`)

Everything the current table has, plus:

| column | notes |
|---|---|
| brand | `normless` / `crewfit` |
| vendor_id | replaces the free-text `vendor` (kept as a snapshot for old rows) |
| quotation_id | the quote it came from, optional |
| title | short name for lists and the vendor link |
| subtotal, gst_amount, other_charges, discount, total_amount | total is what is owed |
| linked_refs | optional Crewfit bulk orders (CF-…) or Normless drops this stock is for |
| status | Draft · Ordered · In production · Partly received · Received · Closed · Cancelled |

Item lines come in two shapes, chosen per line:

- **Simple** — product, quantity, rate (e.g. Spark 3D Print: "Mask", "Disk set").
- **Apparel grid** — today's product, GSM, rate, colour × sizes.

For Normless, the product can be picked from inventory products or typed freely. Amounts are
entered GST-inclusive; the GST part is shown for reference only.

`payment_status` stops being hand-set. It is worked out:
**Unpaid** (0) · **Part paid** · **Paid** (= total) · **Overpaid**.
`receipt_status` likewise: Nothing in · Part received · All received.

### `vendor_order_instalments` (the EMI plan)

| column | notes |
|---|---|
| order_id, seq, label | "Advance", "On dispatch", "After QC" |
| due_date | or `due_on` an event: on order / on dispatch / on receipt |
| amount *or* percent | percent is turned into an amount from the order total |

Status per instalment comes from payments allocated to the order, applied oldest instalment first:
**Due · Overdue · Part paid · Paid**. The plan is a schedule, not a gate — a payment never has to
match an instalment exactly.

### `vendor_payments`

| column | notes |
|---|---|
| vendor_id, paid_on, amount | |
| mode | NEFT · RTGS · IMPS · UPI · Cheque · Cash |
| reference | **UTR / bank transaction no. / cheque no.** — required for everything but cash |
| paid_from | which of our accounts (last 4) |
| proof_path | screenshot / bank advice, private storage |
| bank_txn_id | optional link to a line in `bank_transactions` (v2 suggests it) |
| note, created_by, created_at | |

### `vendor_payment_allocations`

`payment_id, order_id, amount`. One payment usually covers one order, but sometimes it covers two,
or is an advance before an order exists. Unallocated money shows as **"on account"** credit with
that vendor and can be allocated later.

### `vendor_receipts` + `vendor_receipt_lines` (goods in)

| column | notes |
|---|---|
| order_id, received_on, received_by, challan_no | the vendor's delivery challan |
| lines | product · colour · size · qty received · qty rejected (QC) |
| photos, note | |

**Pending = ordered − received (accepted).** Rejected pieces show separately so a reprint or a
deduction can be agreed.

Deliveries often come in small daily lots (the Spark sheet has 15 in three weeks), so
**Record delivery** is a one-line entry: date + quantity per product, pre-filled with the products
still pending. The size grid only appears for apparel lines.

### `vendor_invoices` (uploaded by us or by the vendor)

| column | notes |
|---|---|
| vendor_id, order_id (optional) | the vendor picks the order on their link |
| invoice_no, invoice_date, amount | GST-inclusive |
| file_path, file_name, mime | private storage, PDF / JPG / PNG, ≤ 10 MB |
| uploaded_by | `vendor` or a team username |
| status | Under review · Accepted · Rejected (with reason, shown to the vendor) |

A vendor upload notifies everyone with `can_edit_vendor_orders` (existing notifications bell).
Accepting it doesn't move money — it is the paper trail; the GST register entry is still manual.

## 5. Screens

### 5.1 Vendors list

Columns: Vendor · Category · Brands · Open orders · Ordered value · Paid · **Balance** · Pieces
pending · Last payment. Totals row on top. Search + category filter.

### 5.2 Vendor profile (drawer or page)

```
┌ Mubas Clothings                     [Edit] [Share link ▾] [+ Order] [+ Payment] ┐
│ Ravi · +91 98… · GSTIN 33AAB… · HDFC ••4421 IFSC HDFC000…  [copy bank details]  │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────────────┤
│ Ordered ₹4.2L│ Paid ₹3.1L   │ Balance ₹1.1L│ On account ₹0│ Pending 640 pcs     │
├──────────────┴──────────────┴──────────────┴──────────────┴─────────────────────┤
│ Orders | Quotations | Payments | Receipts | Statement                           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

*Statement* = a running ledger (order raised → debit, payment → credit, balance after each),
downloadable as PDF / Excel. This is the view that replaces the sheet.

### 5.3 Vendor order (drawer, like today's form, wider)

Sections top to bottom:

1. Header — brand, vendor, quotation (attach / pick), dates, status.
2. Items — today's product / colour / size grid with rates.
3. Totals — subtotal, GST, other charges, total.
4. **Payment plan** — instalment rows, with paid / due status chips; "Apply vendor's default plan".
5. **Payments** — the payments allocated here, UTR shown; **+ Record payment**.
6. **Received vs pending** — per colour × size: ordered / received / rejected / pending;
   **+ Record delivery** opens the same grid pre-filled with what's pending.
7. Files, notes, comments (existing comment thread).

### 5.4 Record payment (small drawer)

Vendor → shows bank details and balance. Amount, date, mode, **UTR / reference**, paid from,
proof upload. **Allocate to**: open orders with balance listed, amount auto-filled oldest first,
editable; anything left over stays on account.

### 5.5 Vendor Payments page

All payments across vendors and brands: date range, vendor, brand, mode filters; totals; export.
Plus an **Upcoming / overdue instalments** tab — the "what do we have to pay this week" list.

## 6. Rules & calculations

- `paid(order) = Σ allocations`; `balance = total − paid`.
- Vendor balance = Σ order balances − on-account credit.
- An instalment is **Overdue** when its due date has passed and cumulative paid < cumulative due.
- A payment can't be allocated beyond an order's balance (the excess stays on account).
- Editing an order's total re-derives percent instalments; already-paid instalments stay paid.
- Deleting a payment: admin only, and logged (who, when, the UTR it had).
- Money is stored as `NUMERIC(12,2)`, rupees.

## 7. The vendor link

`https://<crm>/v/<token>` — public, no login, read-only except for **Upload invoice**
(file + invoice no. + date + amount + which order). Uploads are size/type-checked, rate-limited,
and land as "Under review".

- Token: 32 random bytes, URL-safe. One per vendor. **Regenerate** kills the old link;
  **Disable** turns it off. "Last opened" is shown on the profile.
- Shares by **Copy link** or **Send on WhatsApp** (from the brand's number, as the vendor
  order text is sent today).
- Shows: vendor's profile and bank details as we hold them (so they can flag a wrong account
  number), orders with items and status, received vs pending, the payment plan, every payment
  with date / amount / **UTR**, balance, and a downloadable statement PDF.
- Never shows: internal notes, comments, other vendors, who in our team did what, our bank
  account numbers, Normless/Crewfit customer names on linked orders.
- Files (quotes, proof screenshots) are streamed through `/v/<token>/file/<id>` after checking the
  file belongs to that vendor — never a guessable `/uploads` path.
- Branded neutrally (company name, not either store's theme) since the vendor may supply both.
- Rate-limited, `noindex`.

## 7a. WhatsApp updates to vendors (Normless number)

Every action on a vendor's order sends them a WhatsApp from **Normless's number** — for Crewfit
orders too, since it is the one number vendors will know. Vendors haven't messaged us in the last
24 h, so every message is an approved **template** (category UTILITY).

**Built on what already exists.** Normless's automatic messages (`nl-automations` +
`nl-template-set`) already do this for customers: CRM-written templates submitted to Meta from
the Automations page, a once-only send log (`nl_auto_sends`, keyed by event + ref), link buttons
through our `/go/` short links. Vendor messages become a new **Vendors** group there — no second
sending system.

### Events and templates

| event | when | template (draft) | button |
|---|---|---|---|
| `vendor_link` | link first shared / regenerated | Hi {{1}}, this is your vendor page with {{2}}: orders, deliveries, payments and invoices, always up to date. | Open my page |
| `vendor_order` | order raised (or quote accepted) | New order {{1}} for {{2}}: {{3}}. Total ₹{{4}} (incl. GST). Expected by {{5}}. | View order |
| `vendor_order_changed` | items, total or date edited after sending | Order {{1}} has been updated: {{2}}. Please check the latest details. | View order |
| `vendor_payment` | payment recorded | Payment of ₹{{1}} sent on {{2}} by {{3}}, ref {{4}}, for order {{5}}. Balance now ₹{{6}}. | View statement |
| `vendor_delivery` | delivery recorded | Received on {{1}} for order {{2}}: {{3}}. Still pending: {{4}}. | View order |
| `vendor_rejected` | delivery has rejected pieces | {{1}} pieces from {{2}}'s lot of order {{3}} didn't pass QC: {{4}}. | View order |
| `vendor_invoice` | their invoice accepted / rejected | Your invoice {{1}} for ₹{{2}} has been {{3}}. {{4}} | View invoices |
| `vendor_instalment_due` *(optional, off by default)* | day before an instalment is due | Instalment {{1}} of ₹{{2}} for order {{3}} is scheduled for {{4}}. | View statement |

Names follow the existing set: `nlcrm_vendor_order`, `nlcrm_vendor_payment`, … Each button's URL
is `https://ops.normless.store/go/{{1}}`, the code pointing at the vendor's `/v/<token>` page
(anchored to the order). The Automations page shows each one's Meta status
(Pending / Approved / Rejected) with **Create template** and an on/off switch, like the customer
events.

### Rules

- **10-minute hold.** A message is queued, not sent, when the action is saved. Editing or deleting
  the payment/delivery within 10 minutes updates or cancels it, so a typo never reaches the
  vendor. The drawer shows "WhatsApp to vendor in 10 min · Send now · Don't send".
- **Per-action opt-out**: the save button's "Notify vendor" checkbox (on by default) for the odd
  correction that shouldn't be messaged.
- **Per-vendor switch**: "WhatsApp updates" on the vendor profile, and the number to send to.
- **Payments without a UTR** wait (up to the hold) for one; if still blank, "ref" reads
  "will be shared" and adding the UTR later sends nothing new — the vendor sees it on their page.
- Several deliveries on one day for one order are combined into one message.
- Every send is logged on the order's timeline and in the vendor's chat.

### Vendor chats in the Normless inbox

Vendors' replies land in the Normless WhatsApp inbox. Their contact is linked to the vendor
(`wa_contacts.vendor_id`), which:

- **turns the Normless bot off** for that chat — it must never answer a vendor as a customer,
- shows a **Vendor** tag and a link to the vendor's profile,
- keeps them out of customer counts, broadcasts and abandoned-cart audiences,
- routes them to people with `can_view_vendors` (a "Vendors" filter in the inbox).

### Team-side alerts (not WhatsApp)

Vendor uploads an invoice → notification bell for `can_edit_vendor_orders`. Instalment overdue →
daily bell notice to `can_record_vendor_payments`.

## 8. Permissions

Following the new-feature wiring checklist (DB column, Sidebar, route guard, admin.js, auth.js,
Admin.jsx in one change):

| permission | grants |
|---|---|
| `can_view_vendors` | see vendors, orders, quotations, receipts (replaces `can_view_crewfit_vendors`; existing holders migrated) |
| `can_edit_vendor_orders` | create / edit vendors, quotations, orders, receipts |
| `can_record_vendor_payments` | add / edit payments and payment plans; see vendor bank details |
| `can_share_vendor_link` | create / regenerate / disable the vendor link |

Delete stays admin-only, as today.

## 9. Migration

1. `crewfit_vendors` → `vendors` (names de-duplicated case-insensitively, phones kept).
2. `crewfit_vendor_orders` → `vendor_orders` with `brand = 'crewfit'`, `vendor_id` resolved by
   name, ref numbers kept (`VO-0001…` style unchanged).
3. Orders marked **Paid** get one synthetic payment for the full amount, dated the order's
   `updated_at`, reference `"(migrated – no UTR)"`, so balances are right from day one.
   Orders marked **Consignment Received** get one receipt for the full quantity.
4. Old tables are left in place (read-only) until the new pages are confirmed, then dropped.
5. **Excel import**: a one-off script, like the support/Myxture imports, once we have the
   sheet's columns. *Open question 3.*

Note: the local DB tunnels to production, so the schema change runs on prod the first time the
server starts with it — the migration has to be idempotent and safe to re-run.

## 10. Build order

1. Schema + migration; vendor master page + profile (no money yet).
2. Orders moved to the shared route with brand; payments + allocations; vendor statement.
3. Payment plans / instalments; upcoming & overdue view.
4. Receipts (goods in) with per-size pending.
5. Quotations upload + accept → order.
6. Vendor link + invoice upload.
7. WhatsApp vendor templates (submit to Meta early — approval can take a day), the 10-minute
   queue, and vendor chats tagged in the inbox with the bot off.
8. Excel import of the current sheet.

Each step is usable on its own; 1–2 already replace most of the sheet.

## 11. The current sheet, mapped

Sample: *Spark 3D Print Tracker – EDS0109136 (Dsk & Msk)* — one sheet per quotation.

| sheet | CRM |
|---|---|
| Quotation No. EDS0109136, Date 29-Oct-2026 | `vendor_quotations` (quote_no, quote_date) → accepted → `vendor_orders` |
| Vendor (file name: Spark 3D Print) | `vendors` |
| Products "Mask", "Disk set" | two **simple** item lines |
| Dated rows with Mask / Disk-set counts | one `vendor_receipts` row per date |
| Total Received 216 / 152 | worked out: Σ receipts |
| Total Billed 1,77,000 | order total (GST-inclusive) |
| 35,400 | instalment size → plan of 5 × ₹35,400 |
| Paid so far 70,800 / Balance 1,06,200 | worked out from payments |
| Payment Cycle rows (date, amount) | `vendor_payments` — UTR left blank, flagged "Add UTR" |

Not in the sheet, so asked for during import: **ordered quantity per product** (needed for
"pending"), rates, and the remaining instalments' due dates.

The sheet mixes date formats (27/10/2026 vs 11/6/2026). The importer reads dates as DD/MM when
the first part > 12, otherwise uses the sheet's month progression, and shows every parsed date
for a check before saving.

## 12. Still open

1. Ordered quantity for Mask and Disk set on EDS0109136, and when the remaining 3 instalments are
   due — or are they "on delivery of N pieces"?
2. Are the other vendor trackers the same layout (one sheet per quotation)? Then one importer
   handles all of them.
