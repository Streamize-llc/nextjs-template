# Paddle billing

Subscriptions and one-time purchases with [Paddle Billing](https://developer.paddle.com) (Paddle is the merchant of record: it charges the customer, calculates and pays the tax, issues the receipt and invoice, and handles refunds and chargebacks). Next.js + Supabase, nothing to install: the Paddle API is called with `fetch`, Paddle.js is loaded from Paddle's CDN when a checkout opens.

The app runs without any of this configured: the pricing page says "not configured yet" and shows no buy button, and the API routes answer `503 paddle_not_configured`.

## What you get

| | |
|---|---|
| `src/config/billing.ts` | **The one file you edit**: plans (monthly / yearly prices) and one-time products. The pricing page, the checkout, the webhook and the setup script all read it. |
| `/pricing` | Public pricing page with a monthly / yearly switch. A buy button appears only for a price that exists in `.env`. |
| `/billing`, `/billing/success` | The signed-in user's plan and payments, a "Manage billing" button into Paddle's customer portal (card, invoices, change plan, cancel), and the page Paddle returns to after paying. |
| `POST /api/billing/checkout` · `portal` · `sync` | Create a checkout · open the portal · re-read the user's subscriptions from Paddle (heals a slow or lost webhook). |
| `POST /api/webhooks/paddle` | The webhook: verifies the signature, is idempotent, ignores what is not yours. |
| `supabase/migrations/…_paddle_billing.sql` | `billing_customers`, `billing_subscriptions`, `billing_transactions`, `billing_adjustments`, `billing_webhook_events`, with Row Level Security: a user reads only their own rows, **nobody** writes from the browser. |
| `src/lib/paddle/entitlements.ts` | `getEntitlement()` and `hasPurchased()`: what the rest of your app calls. |
| `scripts/paddle-setup.mjs` | `npm run paddle:check`, `paddle:catalog`, `paddle:webhook`. |

## Set it up (sandbox, about 15 minutes)

1. **Database.** Apply the migration: `npm run db:reset` (local Supabase) or `npm run db:push` (remote). Put `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (server only; Supabase dashboard > Project settings > API).
2. **Your plans.** Edit `src/config/billing.ts`: names, features, prices. Keys are lowercase letters, digits and underscores (`pro`, `team_plus`): they go into the database and into env var names.
3. **A Paddle sandbox account** at <https://sandbox-vendors.paddle.com> (it is separate from the live account and has its own keys). Developer tools > Authentication: create an **API key** and a **client-side token**. Copy `.env.example` to `.env.local` and fill in:
   ```
   PADDLE_APP_TAG=my-app                         # short, unique per app on your Paddle account
   NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox
   PADDLE_API_KEY=pdl_sdbx_apikey_...
   NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_...
   ```
4. **Create the products and prices** in Paddle from your config, and write their ids into `.env.local`:
   ```bash
   npm run paddle:catalog -- --write
   ```
   Run it again after you change a price or add a plan: what already exists is reused, never duplicated.
5. **The webhook.** Paddle must reach your app from the internet. Locally, open a tunnel (`ngrok http 3000`), then:
   ```bash
   npm run paddle:webhook -- https://<your-tunnel>/api/webhooks/paddle --write
   ```
   This creates the notification destination and writes its signing secret to `.env.local`. Restart `npm run dev`.
6. **Check.** `npm run paddle:check` prints a ✔ / ✖ for every setting and says what to do about each ✖. Aim for "Ready."
7. **Try it.** Sign in (the template has no login page: add yours; billing only needs a Supabase session), open `/pricing`, choose a plan and pay with a [test card](https://developer.paddle.com/concepts/payment-methods/credit-debit-card): `4242 4242 4242 4242` pays; `4000 0000 0000 0002` is declined; `4000 0038 0000 0446` asks for 3-D Secure. Any future expiry, any CVC. You land on `/billing/success`, then `/billing` shows the plan and the payment.

In the sandbox, refunds you create (Paddle dashboard or API) are approved by Paddle about every 10 minutes; until then the refund is `pending_approval` and `billing_transactions.refunded` stays 0.

## Use it in your app

```ts
import { getEntitlement, hasPurchased } from "@/lib/paddle/entitlements";
import { createClient } from "@/utils/supabase/server";

const supabase = await createClient();
const { data: { user } } = await supabase!.auth.getUser();

const entitlement = await getEntitlement(supabase!, user!.id);
if (!entitlement.active) redirect("/pricing");          // active = running subscription (active or in a trial)
if (entitlement.planKey === "team") { /* team-only feature */ }
entitlement.cancelAtPeriodEnd;                          // the user cancelled: still active until currentPeriodEnd
entitlement.pastDue;                                    // the last payment failed and Paddle is retrying: YOU decide whether to keep access

await hasPurchased(supabase!, user!.id, "credits_100"); // a one-time product from billingConfig.products
```

What a plan *allows* is your code, keyed on `planKey`. To grant something when a payment arrives (credits, a licence), add it in `src/lib/paddle/webhook.ts` where `applyTransaction` records the payment: it runs once per payment, and `billing_transactions` is your ledger.

## How it stays safe

- **A payment is credited through the Paddle customer, never through anything the browser sends.** Before a checkout opens, the server finds or creates the Paddle customer for the signed-in user's e-mail and links it (`billing_customers`). Every later webhook is credited to the user who owns that customer. A payment from a customer the server never linked is ignored, so a visitor who opens Paddle's checkout on your price with someone else's id in the custom data gets nothing credited to anyone.
- **A checkout needs a confirmed e-mail address** (`403 email_not_verified` otherwise). A Paddle customer is found by e-mail and is shared by every app on the Paddle account, so linking one to an address nobody confirmed would let a stranger who signs up with it open that customer's portal. Keep e-mail confirmation on in Supabase (Authentication > Providers > Email), or sign users in with OAuth, which confirms the address.
- **Only your prices count.** An event whose items are not the `PADDLE_PRICE_*` ids in your environment is ignored (it belongs to another app on the same Paddle account). Paddle sends every destination the events of the whole account.
- **The server creates the transaction.** The browser names *what* to buy (`pro` + `month`); the price, the quantity (1) and the customer are fixed by `/api/billing/checkout`.
- **The signature is checked on the raw body**, with any one of several `h1` values accepted (secret rotation) and a five-minute tolerance. No secret configured means the webhook refuses, never accepts.
- **Idempotent and order-safe.** An event id is processed once; a failed one is retried by Paddle and picked up again; an older subscription event never overwrites a newer one.
- **A key of the wrong environment is refused**: a sandbox key with `NEXT_PUBLIC_PADDLE_ENVIRONMENT=production` (or the reverse) throws, rather than charging the wrong account.
- **Row Level Security**: users read only their own billing rows; no browser role can write any of them; the webhook log is closed to the browser. Writes use the service role, on the server only (`src/utils/supabase/admin.ts` imports `server-only`).

If several apps share one Paddle account (the usual case when you clone the template), give each its own `PADDLE_APP_TAG` and its own notification destination. Nothing else is needed: their events reach each other's webhooks and are ignored.

## Deleting a user

Deleting a Supabase user removes their `billing_*` rows (cascade) but **not their Paddle subscription**: Paddle keeps charging. Cancel it first, from your account-deletion code, with the subscription id from `billing_subscriptions` and Paddle's cancel call (`POST /subscriptions/{id}/cancel` with `{ "effective_from": "immediately" }`), or send the user to "Manage billing" before they delete the account. Refund policy questions are yours and Paddle's, not the template's.

## Go live

1. **Paddle verifies you** (identity and business), then the **domain you sell on must be approved** (Paddle > Checkout > Website approval). Until it is approved, the checkout does not open on that domain. What the review reads on the live site (most are approved automatically; a manual review takes about 5-7 business days):
   - a clear description of the product, its key features and **pricing** (`/pricing` is made for this; keep real prices on it),
   - **Terms of Service, Refund Policy and Privacy Policy**, reachable from the navigation or footer, with your company's name in the Terms,
   - HTTPS, a live site, nothing that reads as a pre-sale or "coming soon".
   Check Paddle's [Acceptable Use Policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) too: for example, prepaid stored value (store credit, gift cards) and some AI content generation (deepfakes, voice impersonation) are not allowed. The template ships no legal pages: write yours.
2. **Create live credentials** in the live Paddle account (a `pdl_live_` API key, a `live_` client-side token) and keep them in a separate file, not in `.env.local`:
   ```bash
   # .env.production.local: PADDLE_API_KEY=pdl_live_..., NEXT_PUBLIC_PADDLE_ENVIRONMENT=production, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=live_..., PADDLE_APP_TAG=my-app
   node --no-warnings --env-file=.env.production.local scripts/paddle-setup.mjs catalog --live --yes --write --out=.env.production.local
   node --no-warnings --env-file=.env.production.local scripts/paddle-setup.mjs webhook-create https://yourdomain.com/api/webhooks/paddle --live --yes --write --out=.env.production.local
   ```
   On the live account every command that changes something needs `--live --yes`, and the webhook destination is created **inactive**.
3. **Set the environment** on your host (Vercel): everything in `.env.production.local` plus `SUPABASE_SERVICE_ROLE_KEY`, then deploy. Confirm `https://yourdomain.com/api/webhooks/paddle` answers `401` to an unsigned request.
4. **Activate the webhook** after the deploy: `node --no-warnings --env-file=.env.production.local scripts/paddle-setup.mjs webhook-activate <id> --live --yes`.
5. **Buy your smallest plan with a real card and refund it** from the Paddle dashboard; check `/billing` and the `billing_*` rows.

## Troubleshooting

| You see | Cause |
|---|---|
| `503 paddle_not_configured` (checkout, portal, sync, webhook) | `npm run paddle:check` lists what is missing. The reason is in the server log (`[paddle] ...`). |
| The webhook answers `401 invalid_signature` | `PADDLE_WEBHOOK_SECRET` is not the secret of the destination Paddle is calling (a destination has its own), or the app was not restarted after you changed it. |
| Paddle shows webhook deliveries failing with `500` | Read the server log. Paddle retries for days; fix the cause and the deliveries are applied. `billing_webhook_events` keeps the payload and the error. |
| `/billing/success` waits a minute, then says it is slow | The webhook has not arrived. Is the destination active, its URL reachable, the tunnel up? The page asks the server to sync, so a paid plan still appears. |
| `403 email_not_verified` | The user has not confirmed their e-mail address (see "How it stays safe"). |
| `409 already_subscribed` | One subscription at a time: changing plan or cancelling goes through "Manage billing". |
| `409 customer_conflict` | Two accounts in your database share one e-mail address, and the Paddle customer is already linked to the other one. |
| The checkout overlay does not open on your live domain | The domain is not approved yet. |
| A button says "Not available yet." | That plan's price id is not in `.env`: `npm run paddle:catalog -- --write`. |

## Tests

`npm test` runs the unit tests (Node 22.18+ is needed: they run the TypeScript directly). They cover the signature, the configuration rules, the checkout request, every webhook flow (subscription lifecycle, payments, refunds, duplicates, out-of-order, failures and redelivery), the Supabase store, the four routes, and the pricing table. `npm run typecheck` and `npm run lint` as usual.
