# Connecting WhatsApp

Written for whoever sets this up in Meta — it assumes nothing beyond a Facebook account and
access to the Crewfit business.

The CRM talks to Meta's WhatsApp Cloud API directly. There is no third-party inbox in between, so
everything below happens once, in Meta's own dashboard, and the CRM is given five values at the
end of it.

---

## 1. What you get before you commit a real number

Meta gives every app a **free test number**. It can send to five phone numbers you verify, costs
nothing, and is the right thing to build against. **It does not touch any number you use today.**

The decision to be careful about comes later, at step 6: a number connected to the Cloud API
**stops working in the WhatsApp Business app on the phone**. Everything then arrives in the CRM
and nowhere else. Do not connect the number the office currently chats on until the inbox is
doing what you want.

---

## 2. Make the app

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Pick **Business** as the type. Name it something like `Crewfit CRM`.
3. On the app dashboard, find **WhatsApp** in the product list → **Set up**.
4. It will ask for a Meta Business account — pick the Crewfit one, or let it create one.

You now have a test number and an **API Setup** page. Keep that page open: three of the five
values come from it.

---

## 3. The five values the CRM needs

| What | Where it comes from |
|---|---|
| `WA_PHONE_NUMBER_ID` | WhatsApp → API Setup, under the test number. A long number, **not** the phone number itself. |
| `WA_BUSINESS_ACCOUNT_ID` | The same page, labelled *WhatsApp Business Account ID*. |
| `WA_ACCESS_TOKEN` | The same page: **Temporary access token**. It lasts 24 hours — fine for testing, replaced in step 7. |
| `WA_APP_SECRET` | App settings → Basic → **App secret** → Show. This is what proves a webhook really came from Meta. |
| `WA_VERIFY_TOKEN` | You invent it. Any random string; it is typed into Meta in step 5 and into the CRM. |

There is a sixth, optional: `WA_API_VERSION` (e.g. `v21.0`). Leave it out unless Meta's docs say
the current version has moved on.

None of these go in git. They go in `.env` on the server, and into the command you start the
local server with while testing.

---

## 4. Add your own phone as a test recipient

On the API Setup page, under **To**, add your mobile number and confirm the code WhatsApp sends
you. Until a number is on that list the test number cannot message it.

---

## 5. Point Meta at the CRM

Meta will only call a public **https** address, so while testing locally you need a tunnel to
your machine. Either of these works; cloudflared needs no account:

```bash
# in one terminal, leave it running
cloudflared tunnel --url http://localhost:5001
# it prints something like https://odd-words-here.trycloudflare.com
```

```bash
# or, if you already use ngrok
ngrok http 5001
```

Then in the Meta dashboard: **WhatsApp → Configuration → Webhook → Edit**

- **Callback URL**: `https://<the tunnel address>/api/whatsapp/webhook`
- **Verify token**: the `WA_VERIFY_TOKEN` you invented

Press **Verify and save**. Meta calls the URL once; if the CRM is running with the same verify
token it answers and the dialog closes. Then press **Manage** beside *Webhook fields* and
subscribe to **messages**. Nothing arrives without that subscription.

Start the local server with the values from step 3:

```bash
AUTO_SYNC=off PORT=5001 \
  WA_PHONE_NUMBER_ID=... \
  WA_BUSINESS_ACCOUNT_ID=... \
  WA_ACCESS_TOKEN=... \
  WA_APP_SECRET=... \
  WA_VERIFY_TOKEN=... \
  node server/index.js
```

Message the test number from the phone you verified. It should appear in **Crewfit → WhatsApp**
within a few seconds, with an enquiry created against the number. Reply from the CRM and it
should land on the phone, with the ticks filling in as it is delivered and read.

---

## 6. When you are ready for the real number

In **WhatsApp → API Setup → Add phone number**, with the warning from step 1 firmly in mind:

- the number leaves the WhatsApp Business app and lives in the CRM from then on;
- it needs a verification code by SMS or call, so you must be able to receive on it;
- a display name has to be approved by Meta, which usually takes a few hours;
- if the number is currently on the WhatsApp Business app, export anything you need from it
  first — old chats do not come across.

---

## 7. A token that does not expire

The temporary token dies after 24 hours. For the server, make a permanent one:

1. <https://business.facebook.com> → **Business settings** → **Users → System users** → **Add**.
2. Name it `crm-whatsapp`, role **Employee**.
3. **Assign assets** → your app and your WhatsApp account → full control.
4. **Generate new token** → pick the app → tick `whatsapp_business_messaging` and
   `whatsapp_business_management` → **Generate**.
5. Copy it once — Meta never shows it again — and put it in the server's `.env` as
   `WA_ACCESS_TOKEN`.

Then point the production webhook at `https://ops.normless.store/api/whatsapp/webhook` with the
same verify token, and subscribe to **messages** there too.

---

## What to expect afterwards

- **The 24-hour rule is Meta's, not ours.** Once a customer has been quiet for a day, WhatsApp
  refuses anything but a template they have approved. The CRM shows that the window has closed
  rather than letting the send fail; approved templates come in a later phase.
- **The first message from a number creates an enquiry.** It is a lead in its own right, not a
  quote — most enquiries never become one, and a quote list that is really an enquiry list
  answers neither question.
- **Access is two grants.** *WhatsApp inbox* lets somebody see and answer their own conversations
  and anything unclaimed; *WhatsApp — every conversation* adds seeing all of them and moving them
  between people. Both are set per user in Admin, under Crewfit.
