# Shipping with Delhivery: User Manual

The CRM runs our Delhivery shipping end to end: getting AWBs and labels, booking pickups, tracking every parcel, re-creating cancelled ones and answering failed deliveries. This manual walks a new team member through each step, in the order you meet them.

## How a parcel moves

[[DIAGRAM]]

The main road runs from **Pending AWB** to **Delivered**. The side roads are where you act: an order **on hold** waits for Shopify, a **cancelled** parcel gets a new AWB, and a **failed delivery** is re-attempted or returned.

## Who can do what

Access is set per person under **Admin → Users**. Ask an owner or admin if a button you need is missing.

| Access | What it lets you do |
| --- | --- |
| **Shipping: view** | Open the Shipping page, see every shipment, search, filter, download CSVs and print labels |
| **Shipping: manage** | Everything above, plus get AWBs, create manual shipments, edit, cancel, re-create, book pickups and answer failed deliveries |
| **Owner or admin** | Everything above, plus change Shipping → Settings |
| **Support: edit** | On a support ticket, change a customer's delivery details before Delhivery picks the parcel up |
| **Anyone signed in** | See a parcel's Delhivery status on support tickets, marketing orders and the scanner |

Managing shipments spends money from the Delhivery wallet, so give **Shipping: manage** only to the people who ship.

## The Shipping page at a glance

Open **Shipping** in the left menu. A red number on it means auto-cancelled parcels are waiting for you. At the top are **Update tracking**, **New shipment** and the AWB / order search; below them, any Delhivery errors, then the tabs.

| Tab | What it is for |
| --- | --- |
| **Overview** | What needs doing first, counts for every status, delivery performance, and freight spend with a link to the Delhivery wallet |
| **Shipments** | Every order and parcel by status, like the Delhivery portal's Orders page |
| **Auto-cancelled** | Parcels Delhivery cancelled that still need a new AWB, or marking as not shipping |
| **Pickups** | Book a pickup and see every parcel waiting, oldest first |
| **Failed deliveries** | Delivery attempts that failed: re-attempt, change the phone or address, or have it returned |
| **Activity** | Every bulk action and automatic job, with each failure and its reason |
| **Settings** | Warehouse, packaging, packing rules, automation and alerts (owners and admins) |

The status lists on the Shipments tab:

| List | Means |
| --- | --- |
| **Pending AWB** | Orders not shipped yet and with no AWB. These are the ones to pack and ship |
| **On hold** | Orders on hold in Shopify, usually a return or exchange waiting for a decision. They can't get an AWB until Shopify releases them |
| **Ready to ship** | AWB made, no pickup scheduled yet |
| **Ready for pickup** | A pickup is scheduled, or Delhivery came and couldn't take it yet |
| **In transit** | Picked up and on the way |
| **Out for delivery** | With the delivery person today |
| **Delivery failed** | The delivery attempt failed (customer unavailable, refused, wrong address) |
| **RTO in transit** / **Returned (RTO)** | Coming back to us after failed deliveries / back with us |
| **Delivered** | Done |
| **Auto-cancelled** | Cancelled by Delhivery and not dealt with yet |
| **All shipments** / **Manual shipments** | Everything / only the ones typed in by hand |
| **Customer returns** | Return and exchange pickups from customers, kept apart from our shipments |

## Your daily routine

The rule that prevents most problems: **get the AWB only after the order is packed.** Delhivery cancels parcels that aren't ready when the pickup person comes.

1. **Morning: clear the alerts.** Open Shipping. Dismiss or act on any red Delhivery error at the top, then open **Auto-cancelled** and re-create or mark each parcel (see *When Delhivery cancels a parcel*).
2. **Check failed deliveries.** On **Failed deliveries**, re-attempt, fix the phone or address, or return each one, so Delhivery tries again the same day.
3. **Pack.** Scan each order at the packing table (Scan Order). The scanner warns you about orders on hold and cancelled labels.
4. **Get AWBs for what's packed.** Shipments → **Pending AWB** → filter **Packed** → select the orders → **Get AWB and labels**. Print the labels and stick them on.
5. **Book the pickup** on the **Pickups** tab before the cut-off, unless automatic pickup is switched on in Settings.
6. **Before the pickup arrives**, check **Ready to ship** and **Ready for pickup**: every parcel listed there must be on the shelf, packed and labelled.
7. **During the day, answer support.** Customer changes go through the ticket (see *Support tickets and marketing orders*).
8. **Evening: glance at the Overview.** Parcels waiting more than 2 days and anything "not ready when Delhivery came" need attention tomorrow morning.

Tracking updates by itself every 30 minutes. Press **Update tracking** at the top when you need it now.

## Getting an AWB and the label

An AWB (Delhivery's tracking number) is created from **Shipments → Pending AWB**. Each AWB costs freight from the Delhivery wallet.

**One order**

1. Press **Get AWB** on the order's row. The drawer checks the order with Shopify and Delhivery: address, mobile, pincode serviceability, COD availability and the freight estimate.
2. If a red problem shows (wrong phone, short address, pincode not serviceable), press **Edit details**, fix it and save. The change is kept in the CRM and used for this AWB; Shopify keeps its own copy. You can also press **Edit** on the row before opening the drawer.
3. Check the **Packaging**. The suggested one comes from the packing rules and says why ("Doomsday Mask goes in a medium box"). Pick another if the parcel is different, and type a **weight** or **size (L × B × H)** if it differs from the packaging's.
4. Check **Payment**. COD amounts come from Shopify; a partly paid order collects only what is still owed.
5. Press **Create shipment and get label**. Open the 4×6 label and print it.

**Many orders at once**

1. Tick the orders (or the box at the top to select the whole page) and press **Get AWB and labels for N**.
2. Leave packaging on **Packing rules** so each order gets what its items need, or pick one packaging for all.
3. The result lists every AWB created, the label files, and each order that failed with Delhivery's reason. Fix those and try again.

**What happens after you press Create**

- Delhivery gives the AWB. Re-made orders are named like the portal does it: 13143A, 13143B.
- The label is fetched (4×6). If it isn't ready, use **Label** on the shipment later.
- Shopify marks the order fulfilled with the AWB, which sends the customer the Shipped WhatsApp.
- The parcel moves to **Ready to ship**, then **Ready for pickup** once Delhivery schedules it.

Orders **on hold** can't get an AWB: they are listed under **On hold** and move back to Pending AWB once Shopify releases them.

## When Delhivery cancels a parcel

If the pickup person comes and the parcel isn't handed over, Delhivery marks it **Not Picked** and the portal shows it as **CANCELLED**. The CRM treats it the same way: the parcel still sits on our shelf and needs a new AWB and a new label.

**How you hear about it**

- A bell notification for everyone with Shipping access, about 3 hours after Delhivery cancels it (some parcels are still picked up later the same day, and those never alert).
- A red count on **Shipping** in the menu and on the **Auto-cancelled** tab, until each one is dealt with.
- Optionally a WhatsApp to the ops number (Settings → Alerts).

**What to do**

1. Open **Auto-cancelled**. Every parcel there still needs action.
2. Tick the ones to send and press **Re-create**. Each gets a new AWB (13143A, then 13143B) with the same address, COD amount and packaging; pick another packaging first if needed.
3. Print the new labels and **swap them for the old ones**. The old label is dead: the scanner warns if someone scans it.
4. Book a pickup if today's has gone.
5. For parcels that shouldn't go (the customer cancelled, it went another way), tick them and press **Mark as not shipping**.

**What the CRM does for you**

- Shopify's tracking number is swapped for the new AWB, and the customer gets the Shipped WhatsApp again with the new tracking link.
- A re-make your team does in the Delhivery portal (Clone order) is found within 30 minutes, linked to the old parcel and taken off the list. If the clone is less than 2 days old, Shopify and the customer are updated too.
- An order cancelled in Shopify is marked **not shipping** by itself.
- A support ticket or marketing order that showed the old AWB switches to the new one.

## Changing a shipment

What can change depends on how far the parcel has gone. Once Delhivery picks it up, it is in their hands.

| What to change | No AWB yet | AWB, waiting for pickup | Picked up |
| --- | --- | --- | --- |
| Name, mobile | Yes | Yes | Yes, from Shipping only (helps the delivery person) |
| Address (same pincode) | Yes | Yes | Yes, from Shipping only |
| Pincode, city | Yes | No: cancel the AWB and re-create it | No |
| Products and sizes (label text) | Yes | Yes | No |
| Payment (COD / prepaid), COD amount | Yes, in the ship drawer | Yes | No |
| Packaging, weight, size | Yes, in the ship drawer | Yes | No |

**Where to change it**

- **No AWB yet:** Shipments → Pending AWB → **Edit** on the order (or **Edit details** in the ship drawer). Saved in the CRM and used when the AWB is made.
- **AWB made:** open the shipment (click its row, or search its AWB) → **Edit shipment**. Only what you change is sent to Delhivery. After pickup the form offers only name, phone and address.
- **A customer asked through support:** use the ticket (next sections). Support can change details only before pickup.
- **Cancel instead:** **Cancel shipment** before pickup cancels the AWB. After pickup the button is **Return to us**, which turns it into a return (RTO) and can't be undone.

A different size or product means a different garment in the parcel: repack it before the pickup, then update the products text so the label and Delhivery's records match.

## Manual shipments

A manual shipment is a parcel that isn't a normal Shopify order: a replacement, a re-send, a marketing parcel, a sample. It gets a Delhivery order ID of its own (M1001, M1002…) and its own list, **Shipments → Manual shipments**.

**From Shipping**

1. Press **New shipment** at the top of the Shipping page.
2. Fill **Deliver to**: name, 10-digit mobile, address, city, state, pincode. If it replaces a Shopify order, type the order number and press **Fill from #order** to copy the order's address.
3. Fill **What's in it**: products and sizes as they should read on the label, the number of pieces and the declared value.
4. **Payment** is prepaid by default; switch to COD and type the amount to collect if needed.
5. Pick the **Packaging**. Leave the weight blank to have it worked out, or type it; the size can be typed too.
6. Press **Create shipment and get label**. The panel lists anything still missing before it lets you.

**From a support ticket or a marketing order:** press **Create Delhivery shipment** inside the ticket or order. The form opens filled with what the ticket or order knows, and the new AWB is saved back on it: a ticket's **Forward AWB**; a marketing order's AWB, tracking link and status **Dispatched**.

## Support tickets and marketing orders

Both show where each parcel is, from the CRM's Delhivery tracking, and keep their AWB current by themselves.

**On a support ticket**

- Under **Forward AWB** and **Return AWB** you see the parcel's status (Waiting for pickup, In transit, Delivered…) and Delhivery's latest words.
- If the forward parcel was cancelled and re-made, it says **Replaced by** the new AWB; press **Use it**. A ticket with no Forward AWB is filled from the order's shipment on the next sync.
- **Customer wants to change the delivery** tells you what is still possible for this order and opens the change form:
  - **No AWB yet:** any detail can change; it is saved and used when the order is shipped.
  - **Waiting for pickup:** name, mobile, address and products go straight to Delhivery. City, state and pincode are locked: a new pincode needs the AWB cancelled and re-created by Shipping.
  - **Picked up:** the button is disabled and says why. Ask Delhivery support, or arrange a return.
- After a change, a line is added to the ticket's operations note. Leave a field blank to keep what the order has; for a size change write the new product and size, for example "Dr Doom Hoodie - Green / L".
- **Create Delhivery shipment** sends a replacement or re-send (see *Manual shipments*).

**On a marketing order**

- The orders list shows each parcel's status under its AWB; "Cancelled: new label" means it needs re-creating in Shipping.
- An order with a Shopify order number gets its AWB, tracking link and **Dispatched** status from the shipment by itself, and moves to **Delivered** when Delhivery delivers it.
- **Create Delhivery shipment** in the order sends the parcel and fills in the AWB, tracking link and status.

## Pickups, failed deliveries and returns

**Pickups**

- The **Pickups** tab lists every parcel waiting at the warehouse, oldest first, with Delhivery's last word on it. "Not ready when Delhivery came" means the pickup person found it unpacked: these are the next to be cancelled.
- **Book pickup** asks Delhivery to come at the pickup time in Settings, for the number of parcels waiting. One booking a day is enough. If Delhivery runs a daily pickup for our account already, you don't need to book.
- **Automatic pickup** (Settings → Automation) books it for you between 10 AM and 4 PM when parcels are waiting and none is booked yet.

**Failed deliveries**

When a delivery attempt fails, the parcel moves to **Failed deliveries** with the reason (customer unavailable, refused, address incomplete).

1. Call or WhatsApp the customer.
2. Press **Re-attempt delivery** if they will be available, or **Edit shipment** to fix the phone or address first.
3. Press **Return to us** if they don't want it. This is a return (RTO) and can't be undone.

After about three failed attempts Delhivery sends it back by itself: **RTO in transit**, then **Returned (RTO)**.

**Customer returns and exchanges** (pickups from the customer, booked through the returns app) are listed under **Customer returns**, apart from our shipments: Waiting for pickup, On the way back, Received, and Closed when the pickup was cancelled.

## Finding things: search, filters, CSV and labels

**The search at the top of Shipping** works like the Delhivery portal's. Choose **AWB or order**, **AWB** or **Order ID**, paste one or many (separated by spaces or commas) and press **Find**:

- One shipment found: it opens.
- Several found: they are listed.
- An order with no AWB yet: you land on **Pending AWB** (or **On hold**) with it listed.

**Inside a list**, the search box narrows that list by AWB, order, name, phone or city. **Filters** adds:

| Filter | Use it for |
| --- | --- |
| Manifested (from, to) | Parcels whose AWB was made in a date range |
| Order received (from, to) | Orders placed in a date range |
| Product | One product, for example Dr Doom Hoodie |
| Colour, Size | Taken from the variant ("Green / XL"): every order with that colour or size |
| COD and prepaid | Payment type |
| Packed or not | On Pending AWB: only packed orders, or only unpacked |

**Download CSV** saves exactly the list you are looking at, with every row (not just the page on screen) and the filters applied: order, AWB, status, customer, items, freight, weight, dates.

**Pages:** lists show 10 to 100 rows per page (bottom right) with page numbers, like the Orders page.

**Labels**

- One parcel: the printer icon on its row, or **Label** inside the shipment.
- Several: tick them and press **Labels for N**. Delhivery returns PDF files of up to 25 labels each; open and print each file.
- Labels are 4×6 inches, ready for the thermal printer.

## Scanning at the packing table

**Scan Order** accepts the order number or the AWB barcode on a Delhivery label. It shows the order, its items and, above them, any warning:

| Warning | What to do |
| --- | --- |
| **ON HOLD in Shopify** | Don't pack it. Someone stopped it on purpose; check with the team |
| **AWB … is CANCELLED by Delhivery — don't send this label** | Put the parcel aside. Re-create it in Shipping → Auto-cancelled and print the new label |
| **This label was cancelled — use the new one, AWB …** | The order already has a new AWB. Print that label from Shipping and swap it |
| **Delhivery: Waiting for pickup / In transit …** | Information only: the parcel's current status and AWB |
| **Can be filled from the RTO shelf** | Use the returned piece instead of printing a new one |

A cancelled label that goes out with the parcel is not picked up, so this check saves a lost day.

## Packaging and packing rules

Delhivery charges by the bigger of the real weight and the size-based (volumetric) weight. When the weight we declare is lower than what they measure, the wallet is debited the difference later ("Captured weight is higher than declared weight"). Accurate packaging stops those surprise debits. An owner or admin sets this up once in **Shipping → Settings**.

**1. Packaging** (Settings → Packaging). One row per polybag or box you use: name, polybag or box, length × breadth × height in cm, empty weight in grams, and how many pieces fit. Then choose the **Default packaging** and the **Weight per piece** used when nothing else knows a product's weight.

**2. Order combinations** (Settings → Packing rules). Rules for a whole order, checked first, top to bottom; the first one that fits decides. Each rule says:

- **The order has**: products or product types with a minimum quantity, for example Dr Doom Hoodie at least 1 and Doomsday Mask at least 1. Leave empty for "any products".
- **Pieces from / to**: the number of pieces in the order, for example from 3 (to blank) for "3 or more".
- **Packaging** to use, and optionally a fixed **Weight**.

Example order of rules: 1. "Hoodie + Mask → Medium box", 2. "3 or more pieces → Large box", 3. "2 pieces → Large polybag". Use the arrows to reorder.

**3. Per-product rules.** For orders no combination fits: a product or product type gets a packaging and, optionally, its weight per piece. The order goes in the biggest packaging any of its items needs, and steps up a size when there are more pieces than it fits.

**Per order, people still decide:** the ship drawer shows the suggestion and the reason ("rule Hoodie + mask"), and any packaging, weight or size can be changed before the AWB is made.

Changes in Settings take effect after **Save settings** in the bar at the bottom; **Discard** undoes them.

## Freight, the wallet and recharging

**Freight per shipment.** The **Freight** column on the Shipments lists shows each parcel's freight from Delhivery's rate calculator, the price per item when there is more than one, and the zone. Opening a shipment adds the COD fee and the weight Delhivery actually charged; a warning shows when that weight is above what we declared. These are estimates: the wallet shows the final amounts. They need the **Warehouse pincode** in Settings → Warehouse (our portal shows 600125) and fill in over a few syncs.

**Spend.** The **Overview** shows the estimated freight for the last 7 and 30 days.

**Balance and recharge.** Delhivery doesn't let other systems read the wallet or take payments, so the balance and recharges stay in the Delhivery portal. Press **Balance and recharge** on the Overview: it opens Delhivery's Wallet page, where you see the current balance, every debit per AWB (including weight-mismatch charges) and the **Recharge wallet** button. Recharging needs a Delhivery login and is done there.

Keep the balance above about a week of spend: when the wallet runs out, Delhivery refuses new AWBs and the CRM shows their error.

## Alerts and Delhivery errors

| What happened | Where you see it |
| --- | --- |
| Delhivery cancelled a parcel | Bell (once per parcel), red count on Shipping and on the Auto-cancelled tab, optional WhatsApp |
| A parcel waited for pickup longer than the limit in Settings (default 2 days) | Bell, once, listing the parcels |
| Delhivery refused something (an AWB, a pickup, an edit, a re-attempt, a cancel) | Bell with Delhivery's own words, and a red banner at the top of Shipping |
| A button you pressed failed | A message at the top of the screen straight away |

**The red banners** at the top of Shipping list failures from the last two days. **Details** opens the Activity tab with every failed order and its reason; **Dismiss** hides the banner for everyone once it is dealt with.

**Activity** keeps the history of every bulk action and automatic job: who ran it, what worked, what failed and why. Use it to answer "what happened to order X yesterday?"

**WhatsApp alerts** (Settings → Alerts) go to the ops number from the Normless WhatsApp number. WhatsApp only delivers them if that number has messaged ours in the last 24 hours, so send any message from the ops phone each morning.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| An order isn't in Pending AWB | Search it at the top. It may already have an AWB (made in the portal), be **On hold**, be fulfilled or cancelled in Shopify. Orders appear a few minutes after Shopify sends them |
| Get AWB is greyed out | The drawer lists the problem in red: fix it with **Edit details**, or the order is on hold |
| "already has AWB … (made in the Delhivery portal)" | Someone manifested it in the portal. Use that AWB; don't create a second one |
| "Delhivery doesn't deliver to this pincode" / "No COD here" | Check the pincode with the customer; for COD, ask them to pay online and switch the order to prepaid |
| "Couldn't check Delhivery for existing AWBs" | Delhivery didn't answer. Nothing was created; try again in a minute |
| A parcel stays in Ready for pickup for days | Make sure it is packed and labelled, book a pickup, and check the Pickups tab for "not ready when Delhivery came" |
| The customer wants a new address after pickup | It can't be changed from the CRM. Ask Delhivery support, or let it come back and re-send it |
| A label won't open | Press **Label** again: Delhivery's label links expire after a while |
| Freight shows — | The warehouse pincode is missing in Settings, or the shipment hasn't been priced yet (fills in over the next syncs) |
| Counts differ from the Delhivery portal | Pending AWB leaves out held orders (listed under On hold). Delivered and All shipments in the CRM cover about the last 120 days; the portal counts all time |
| Shopify not updated (on a shipment) | The message says why. The AWB itself is fine; tell an admin if it repeats |

## Words you will see

| Word | Meaning |
| --- | --- |
| **AWB** | Air waybill: Delhivery's 14-digit tracking number for one parcel, printed as the label's barcode |
| **Manifest** | Creating the AWB. A "manifested" parcel has an AWB but may not be picked up yet |
| **Pickup location** | Our warehouse as registered with Delhivery: Normless Warehouse |
| **COD** | Cash on delivery: the delivery person collects the amount shown |
| **NDR** | Non-delivery report: a failed delivery attempt (Failed deliveries) |
| **RTO** | Return to origin: an undelivered parcel coming back to us |
| **Not Picked** (X-PNP) | Delhivery came but didn't get the parcel; shown as Cancelled, needs a new AWB |
| **Not ready for pickup** (FMEOD-152) | The pickup person found the parcel not ready. If it stays that way, Delhivery cancels it |
| **Pickup not attempted** (FMEOD-106) | A pickup is scheduled but hasn't happened yet |
| **Manifest uploaded** (X-UCI) | AWB made, no pickup scheduled yet (Ready to ship) |
| **DTO** | Delivered to origin: a customer return that has reached us |
| **Re-made order (13143A)** | A new AWB for an order whose first one was cancelled; the letter counts the attempts |
| **Manual shipment (M1001)** | A parcel typed in by hand rather than taken from a Shopify order |
| **Volumetric weight** | Weight worked out from the parcel's size; Delhivery charges the higher of this and the real weight |
