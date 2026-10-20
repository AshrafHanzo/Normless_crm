# Normless WhatsApp support — plan

Design: https://claude.ai/artifact/A6cgt2NZ7WkrUKe6SVpVRP (five screens: menu, inbox, ticket from
chat, customer-side bot flows, bot settings).

## What we are building

Normless is B2C: people write about **sizes, products, where their order is, exchanges, returns
and refunds**. A bot answers first, from Shopify's own products and policies and the CRM's orders.
A person steps in only when a rule says so (refund, damaged/wrong item, customer asks, bot unsure,
customer upset). When work is needed, the person raises a **Support ticket (CS-…)** from the chat in
one click, and the customer is told the ticket number on WhatsApp.

This is a second WhatsApp **line** inside the same CRM, not a copy of the Crewfit inbox. Crewfit
keeps leads, quotes and orders; Normless gets customers, Shopify orders and tickets. Both share
the inbox shell, the composer, saved replies, hours, templates and the Meta connection code.

**Where it lives:** Normless › **WhatsApp** in the Normless side menu (next to Support), at
`/whatsapp`. Crewfit keeps its own Crewfit › WhatsApp at `/crewfit/whatsapp`, unchanged. Each
brand's menu shows only its own inbox and settings; there is no switch between numbers inside
the inbox.

**Tickets:** the existing Normless **Support** module (`support_tickets`, CS-… numbers, the same
ticket form and vocabulary). No second ticket system.

## What exists today and what has to change

| Today | Problem for Normless | Change |
|---|---|---|
| One global WhatsApp connection (`services/whatsapp.js` → `useConnection`, `PHONE_ID()`) | Every send goes out from one number | A `wa_lines` table; every send and every webhook is for a line |
| `wa_contacts.phone` is UNIQUE | A customer who writes to both numbers would share one thread | Unique on `(line_id, phone)` |
| Webhook assumes one business number | Messages to the Normless number would land in Crewfit | Route by `value.metadata.phone_number_id` → line |
| Inbox side panel is Crewfit-only (lead, quotes, orders) | Normless needs customer, Shopify orders, tickets | Side panel chosen by the line's brand |
| `wa-ai.js` is a Crewfit sales agent | Wrong knowledge and tools | A separate `nl-bot.js` agent with its own tools |
| Support tickets have no link to a chat | Can't jump from ticket to chat or tell the customer | `support_tickets.wa_conversation_id`, and updates sent to the chat |
| `orders` has no phone and no line-item detail beyond JSON | The bot can't find "my order" by phone | Store order phone + shipping pincode on sync; use `packed_orders` for AWB/tracking |

## Phases

### Phase 0 — prerequisites (you, in Meta and Shopify)

1. The Normless number is the **existing WhatsApp Business app number**. It joins the CRM by the
   same Coexistence route as Crewfit: same Meta app, same App Review and Access Verification
   already submitted — no second review. Staff can keep using the phone app; every chat also
   lands in the CRM, and the last 180 days of chats are imported once, within 24 hours of
   connecting.
2. Once Meta approves the app, connect each number from its own brand: Crewfit › WhatsApp ›
   Settings › Connect, and Normless › WhatsApp › Settings › Connect.
3. Returns & Exchange Center (AfterShip): https://normless.store/apps/aftership-returns-center —
   the bot sends this link for size exchanges and returns.

### Phase 1 — two lines in one CRM (foundation, no visible change for Crewfit)

- New table `wa_lines` (id, brand `crewfit`|`normless`, name, phone_number_id, waba_id,
  display number, sealed token, connected_at, settings JSON). The current connection and the
  `.env` number become line 1 = Crewfit on first start, so nothing breaks.
- `wa_conversations.line_id`, `wa_contacts.line_id`; unique `(line_id, phone)`; existing rows
  backfilled to Crewfit.
- `services/whatsapp.js`: every send function takes the line (token + phone id) instead of
  reading one global. Templates, media upload, `checkToken` per line.
- Webhook: pick the line from `metadata.phone_number_id`; unknown id → log and ignore.
- Connect page: "Connect a number" asks which brand it is for; shows each line's status.
- Permissions (per the wiring checklist: DB column, Sidebar, route guard, admin.js, auth.js,
  Admin.jsx in one change): `can_view_wa_normless`, `can_manage_wa_normless`. Crewfit keeps its
  existing `can_view_whatsapp` / `can_manage_whatsapp`.
- Menu: a **WhatsApp** item in the Normless menu (`/whatsapp`, badge = chats waiting for a
  person) and its settings at `/whatsapp/settings`. Crewfit's menu item is unchanged.
- The Connect page lives in each brand's WhatsApp settings, so connecting from Normless ›
  WhatsApp › Settings › Connect always makes the Normless line.

### Phase 2 — the Normless inbox (people side)

- Queues: **Needs a person**, **Bot handling**, **Mine**, **Ticket open**, **Closed**.
- Thread header: handoff reason chip, "Take over", "Hand back to bot", "Create ticket".
- Handoff note in the thread: why the bot stopped and what it already collected.
- Right panel, tabs **Customer / Tickets / Activity**:
  - Customer matched by phone against `customers` (Shopify), with orders count and spend.
  - Orders for that phone (latest first): items, size, paid/COD, shipped date, courier and AWB
    link from `packed_orders`, delivered date where known.
  - **Policy checks** for the selected order: claim inside 24h of delivery, unboxing video
    received, sale item or not — straight from the refund policy.
  - Past and open tickets for the phone/order.
- Composer extras: send a product card, size chart, order status — all from Shopify data.
- While a person is on the chat, the bot stays silent; "Hand back" lets it take over again.

### Phase 3 — what the bot knows (Shopify → CRM)

- `nl_products`: nightly + on-demand sync of active products (title, handle, type, price,
  compare-at price → "on sale", variants with size and stock, images, tags, product URL on
  normless.store). Uses the existing `fetchProducts`.
- Size charts are already in Shopify, as one of each product's photos (`Oversized_Tshirt_Size_Chart.png`,
  `Tanks_size_chart.png`, …): 79 of the 86 active products have one. The sync picks it out by its
  file name and the bot sends that product's own chart. For the 7 without one (2 joggers, 3
  hoodies, a tee and the mask) Settings can set a chart per product type; with neither, the bot
  says a person will share the measurements and hands over — it never sends a tee chart for a
  hoodie.
- Policies: refund/exchange and shipping policies pulled from Shopify's `policies.json` and
  cached; edited in Shopify, never in the CRM.
- `nl_faqs`: short extra answers written in Settings (COD advance, international shipping,
  refund time…).
- Orders: add `phone`, `ship_pincode`, `email` to the order sync so the bot can match a
  customer. Note the 60-day order window of the current Shopify app — older orders are only
  found if the CRM already has them.

### Phase 4 — the bot

Two layers, like Crewfit:

1. **Welcome menu** (WhatsApp list message): Track my order · Size help · Exchange or return ·
   Something else. Taps go straight to the matching flow without AI.
2. **Agent** (`services/nl-bot.js`, Claude) for free text. Its only tools:
   - `search_products(query)`, `get_product(handle)` — from `nl_products`
   - `send_product(handle)` — product card with photo, price, sizes in stock, link
   - `send_size_chart(product)`
   - `find_orders(phone | order number)` and `order_status(order)` — CRM orders + dispatch log
   - `get_policy(topic)`, `get_faq(topic)`
   - `request_media(kind)` — asks for photos/unboxing video and records what arrived
   - `hand_over(reason, summary, suggested ticket fields)`

   It has **no** tool to refund, replace, discount, edit an order or change an address, so it
   cannot do those. Every price it writes is checked against what the tools returned (the
   `inventedFigure` guard from Crewfit); a made-up figure becomes a handover, not a message.
- **Privacy:** order details are only shared when the WhatsApp number matches the order's
  phone; otherwise the bot asks for the order number **and** the email or pincode on it.
- **Handover rules** (Settings): refund asked · damaged/wrong item (after collecting media) ·
  customer asks for a person · two ungrounded answers · no order found after two tries ·
  upset customer · optional order value above ₹X. Handovers go to the Normless team by the
  existing round-robin assignment.
- Hours: the team replies **9 am – 6 pm**. Outside those hours the bot still answers; a handover
  is told honestly that the team replies from 9 am.
- Language: the bot replies in **English** by default.
- Every bot reply is logged in Activity with the tool calls it used, so a wrong answer can be
  traced.

### Phase 5 — tickets from the chat

- "Raise support ticket" opens the existing Support ticket form (same sections: The order, The
  request, What we did, Where it stands), prefilled: order, customer, phone,
  email, source WhatsApp, nature/reason suggested by the bot, request = bot's summary, chosen
  photos/videos copied into the ticket's images.
- `support_tickets.wa_conversation_id` links both ways: the ticket shows "Open chat", the chat
  shows the ticket chip.
- Optional message to the customer with the CS number.
- When the ticket's action changes (Replacement Initiated, Reshipped, Refunded…) the customer
  gets a WhatsApp update — free inside 24h, otherwise a Normless utility template.

### Phase 6 — settings (Normless line)

Bot (on/off, tone, language) · Knowledge & policies (sync status, extra answers) · Products &
size charts · Handoff rules · Welcome menu · Saved replies · Team · Hours & away · Templates — and
a **Try it** panel to test the bot without sending anything.

### Phase 7 — templates for Normless (Meta approval)

Utility templates only: `nl_ticket_raised`, `nl_ticket_update`, `nl_replacement_shipped`,
`nl_refund_processed`, `nl_reply_after_hours`. Submitted from Settings › Templates as with Crewfit.

### Phase 8 — testing and rollout

- Build and test against a throwaway local Postgres (the usual localhost:5433 is production).
- Bot test set: 40–50 real-style questions (sizes, COD, tracking, exchange, refund, damaged,
  abusive, Hindi/Tamil/Hinglish) run through "Try it"; every refund/damage case must hand over.
- **Shadow week:** bot writes drafts that a person approves with one tap; turn on full auto once
  the drafts are consistently right.
- Then switch the Normless number to the CRM (Coexistence keeps the phone app working).

## Order of work

Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Phases 1 and 2 are useful on their own (a shared inbox for
Normless with Shopify context) even before the bot is switched on.

## Answers (21 Oct 2026)

1. Returns & Exchange Center: https://normless.store/apps/aftership-returns-center
2. Reply time: the team answers 9 am – 6 pm.
3. Size charts: in Shopify, as a product photo on each product (79 of 86 today).
4. Language: English by default.

Still open: who is on the Normless support team — set in Admin with the new Normless WhatsApp
permissions, and shared out by round robin once Phase 4 adds routing.
