# WhatsApp Cloud API Setup

Exactly which credentials you need, where to find each one, and how to wire up
the webhook.

---

## Credentials you must provide

| Variable | Where to get it | Required |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta App Dashboard → WhatsApp → API Setup → "Access token", **or** a permanent token from a System User | Yes |
| `WHATSAPP_PHONE_NUMBER_ID` | Same API Setup panel — labelled **Phone number ID** (a long number, *not* the phone number) | Yes |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Same panel — **WhatsApp Business Account ID** | Recommended |
| `WHATSAPP_VERIFY_TOKEN` | **You invent this.** Any random string, e.g. `openssl rand -hex 24` | Yes |
| `WHATSAPP_APP_SECRET` | App Dashboard → App settings → Basic → **App secret** | Yes — webhook signatures fail without it |
| `WHATSAPP_TEMPLATE_NAME` | WhatsApp Manager → Message templates (only when using templates) | Only if `WHATSAPP_USE_TEMPLATE=true` |

> The temporary access token in API Setup expires in **24 hours**. For anything
> beyond a quick test, create a System User with `whatsapp_business_messaging`
> permission and generate a permanent token.

---

## Step 1 — Create the Meta app

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Choose **Business** type.
3. Add the **WhatsApp** product.

The API Setup panel then shows your test number, its Phone number ID, the
WhatsApp Business Account ID, and a temporary access token.

---

## Step 2 — Add a test recipient

While you are on a test number, Meta only delivers to numbers you have added
explicitly. This is the single most common reason a send fails with error
`131030`.

API Setup panel → **To** field → **Manage phone number list** → add and verify
your own number via the OTP.

To message real customers you must move to a production number and complete
Business Verification.

---

## Step 3 — Choose free-form text or a template

This is a **policy** constraint, not a technical one.

WhatsApp allows free-form messages only inside an open **24-hour customer
service window** — i.e. after the recipient has messaged you. Outside that
window, business-initiated messages **must** use a pre-approved template, or
Meta rejects the send.

### Option A — free-form text (best for local testing)

```ini
WHATSAPP_USE_TEMPLATE="false"
```

Works when you message your own number and have messaged the business recently.
Every send carries the message text as-is.

### Option B — approved template (required for real scheduled sends)

1. WhatsApp Manager → **Message templates** → **Create template**.
2. Category **Utility** (or **Marketing**).
3. Body with one variable, e.g.:

   ```
   Hi, here is your scheduled message: {{1}}
   ```

4. Submit and wait for **Approved**.

Then:

```ini
WHATSAPP_USE_TEMPLATE="true"
WHATSAPP_TEMPLATE_NAME="scheduled_message"
WHATSAPP_TEMPLATE_LANGUAGE="en_US"
```

The text typed into the form becomes the `{{1}}` body parameter.

> Scheduling a message for a future time is almost always *outside* the 24-hour
> window — so template mode is what you need for real use.

---

## Step 4 — Configure the webhook

1. Start a tunnel (see `docs/SETUP.md` §7), e.g.
   `cloudflared tunnel --url http://localhost:3000`.
2. App Dashboard → **WhatsApp** → **Configuration** → **Webhooks** → **Edit**.
3. **Callback URL**:

   ```
   https://<your-tunnel-host>/api/webhooks/whatsapp
   ```

4. **Verify token**: the exact value of `WHATSAPP_VERIFY_TOKEN` in `.env`.
5. Click **Verify and save**. Meta calls your `GET` handler, which echoes
   `hub.challenge` back. If this fails, the tunnel is not reachable or the
   tokens differ.
6. **Manage** the subscription and tick the **messages** field. Without this
   subscription no delivery or read events are sent.

---

## Step 5 — Test end to end

1. Start Redis, the app, and the worker.
2. Schedule a message ~2 minutes into the future.
3. Watch the worker terminal for:

   ```
   Processing scheduled message
   Sending WhatsApp message
   WhatsApp API accepted message
   Message sent — awaiting delivery receipt
   ```

4. Watch the Next.js terminal for the webhook:

   ```
   Webhook processed  { applied: 1, skipped: 0 }
   ```

5. Check the status:

   ```bash
   curl -s localhost:3000/api/messages/<id> | jq '.message | {status, sentAt, deliveredAt, readAt, readStatus}'
   ```

---

## Status semantics

| Stored status | Meaning |
|---|---|
| `PENDING` | Row created, not yet queued |
| `QUEUED` | Delayed job waiting in Redis |
| `SENDING` | Worker claimed it and is calling the API |
| `SENT` | Meta accepted it and returned a `wamid` |
| `DELIVERED` | Recipient's device received it (webhook) |
| `READ` | Recipient opened it (webhook) |
| `FAILED` | API rejected it, or retries exhausted |
| `CANCELED` | Cancelled before sending |

**A `SENT` status means Meta accepted the message — it does not mean it was
delivered or read.** Only webhooks prove that.

### About read receipts

Read receipts are optional in WhatsApp: a recipient can disable them, and some
clients never send them. If `readAt` is null after delivery, the API reports
`readStatus.state = "DELIVERED_NOT_READ"` and says the read status is unknown
rather than claiming the message was not read.

---

## Error codes you are likely to hit

| Code | Meaning | Fix |
|---|---|---|
| `131030` | Recipient not in the allowed list (test number) | Add and verify the number in API Setup |
| `132000` / `132001` | Template does not exist, or parameters do not match | Check `WHATSAPP_TEMPLATE_NAME`, language, and that the body has exactly `{{1}}` |
| `190` | Access token expired or invalid | Generate a new token (24h temporary tokens expire) |
| `131047` | Re-engagement required — outside the 24h window | Switch to template mode |
| `131026` | Message undeliverable — recipient has no WhatsApp | Verify the number |
| `80007` / `429` | Rate limit hit | The worker retries with exponential backoff |
