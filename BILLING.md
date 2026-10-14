# Billing: Paddle and Polar

Subscriptions and one-time purchases through a **merchant of record** (the provider is the seller: it charges the customer, calculates and pays the tax, issues the receipt and invoice, and handles refunds and chargebacks). The template speaks to **two** providers, [Paddle](https://developer.paddle.com) and [Polar](https://docs.polar.sh), through the same routes, the same pages and the same data. Next.js + Supabase, nothing to install: both APIs are called with `fetch`; Paddle.js is loaded from Paddle's CDN only when a Paddle checkout opens.

**You choose per project, and you can change your mind later.** `BILLING_PROVIDER=paddle|polar` decides where **new** checkouts go. Changing it touches nobody who has already paid (see "Switching provider" below). The app runs without any of this configured: the pricing page says "not configured yet" and shows no buy button, and the API routes answer `503 billing_not_configured`.

## Which one?

| | Paddle | Polar |
|---|---|---|
| Customer | found by **e-mail**, shared by every app on your Paddle account | **your user id** (`external_customer_id`), one Polar organization per app |
| Checkout | overlay on your page (Paddle.js) | Polar's own checkout page (redirect) |
| Checkout needs | a **confirmed** e-mail (see "How it stays safe") | nothing special |
| Products | created for you: `npm run paddle:catalog` | created by hand in the dashboard (a checklist: `npm run polar:catalog`), then compared with the catalog: `npm run polar:check` |
| Review | domain approval + business verification before live payments | account review (business, identity, payout) before the first payout; a restricted category (AI generation, ...) may be refused: read its acceptable-use policy first |

Both are Merchants of Record with their own acceptable-use rules and fees: check that your product is allowed **before** you build on one. If you are unsure which will accept you, set up the sandbox of both (it costs nothing), keep both webhooks registered, and decide with `BILLING_PROVIDER`.

## What you get

| | |
|---|---|
| `src/config/billing.ts` | **The one file you edit**: plans (monthly / yearly prices) and one-time products. The pricing page, the checkout, the webhooks and the setup scripts all read it; it is the same whichever provider you use. |
| `/pricing` | Public pricing page with a monthly / yearly switch. A buy button appears only for an item the active provider can sell (its id is in `.env`). |
| `/billing`, `/billing/success` | The signed-in user's plan and payments, a "Manage billing" button into the customer portal **of the provider that bills them**, and the page the provider returns to after paying. |
| `POST /api/billing/checkout` · `portal` · `sync` | Create a checkout at the active provider · open the portal of the user's provider · re-read the user's subscriptions and payments from every provider they have been to (heals a slow or lost webhook). |
| `POST /api/webhooks/paddle` · `/api/webhooks/polar` | The webhooks. **Both stay live whichever provider is active**, so a subscriber of the old provider keeps being updated. Signature checked, idempotent, ignores what is not yours. |
| `supabase/migrations/…_billing.sql` | `billing_customers`, `billing_subscriptions`, `billing_transactions`, `billing_adjustments`, `billing_webhook_events`, with Row Level Security: a user reads only their own rows, **nobody** writes from the browser. Every row says which `provider` it came from; the primary key is (`provider`, `id`). |
| `src/lib/billing/entitlements.ts` | `getEntitlement(supabase, userId)` and `hasPurchased(supabase, userId, key)`: what the rest of your app calls. **They do not care which provider bills the user.** |
| `src/lib/billing/{paddle,polar}/` | One adapter per provider: API client, signature check, payload -> row mapping, sync. `src/lib/billing/adapter.ts` is the interface (a third provider is one more folder). |
| `scripts/` | `npm run billing:check` (which provider takes new checkouts, is each one ready), `paddle:check · catalog · webhook`, `polar:check · catalog · webhook`. |

## Set up Paddle (sandbox, about 15 minutes)

1. **Database.** Apply the migration: `npm run db:reset` (local Supabase) or `npm run db:push` (remote). Put `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (server only; Supabase dashboard > Project settings > API).
2. **Your plans.** Edit `src/config/billing.ts`: names, features, prices. Keys are lowercase letters, digits and underscores (`pro`, `team_plus`): they go into the database and into env var names.
3. **A Paddle sandbox account** at <https://sandbox-vendors.paddle.com> (separate from the live account, with its own keys). Developer tools > Authentication: create an **API key** and a **client-side token**. Add to `.env.local`:
   ```
   BILLING_PROVIDER=paddle
   PADDLE_APP_TAG=my-app                         # short, unique per app on your Paddle account
   NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox
   PADDLE_API_KEY=pdl_sdbx_apikey_...
   NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_...
   ```
4. **Create the products and prices** in Paddle from your config, and write their ids into `.env.local`: `npm run paddle:catalog -- --write`. Run it again after you change a price or add a plan: what exists is reused, never duplicated.
5. **The webhook.** Paddle must reach your app from the internet. Locally, open a tunnel (`ngrok http 3000`), then `npm run paddle:webhook -- https://<your-tunnel>/api/webhooks/paddle --write`. It creates the notification destination and writes its signing secret to `.env.local`. Restart `npm run dev`.
6. **Check:** `npm run paddle:check`, aim for "Ready."
7. **Try it.** Sign in (the template has no login page: add yours; billing only needs a Supabase session), open `/pricing`, choose a plan and pay with a [test card](https://developer.paddle.com/concepts/payment-methods/credit-debit-card): `4242 4242 4242 4242` pays; `4000 0000 0000 0002` is declined; `4000 0038 0000 0446` asks for 3-D Secure. Any future expiry, any CVC. You land on `/billing/success`, then `/billing` shows the plan and the payment.

In the sandbox, refunds are approved by Paddle after a few minutes (up to about ten); until then the refund is `pending_approval` and `billing_transactions.refunded` stays 0.

## Set up Polar (sandbox, about 15 minutes)

1. **Database and your plans**: steps 1 and 2 above.
2. **A Polar sandbox organization** at <https://sandbox.polar.sh> (separate from production). Make **one organization per app**: webhooks belong to an organization, so a shared one would also send your other apps' orders (with buyers' e-mails) here.
3. **Products.** `npm run polar:catalog` prints what to create: for each plan interval one **recurring** product (every 1 month / 1 year) with a **fixed** price, for each one-time product a **one-time** product. Create them in the dashboard, then put each id into `.env.local` (the script prints the variable names, e.g. `POLAR_PRODUCT_PRO_MONTH`). Do **not** create public checkout links for these products: the template creates every checkout itself so that it can tie it to the signed-in user.
4. **An access token** (Settings > Developers) with the scopes `checkouts:write`, `customer_sessions:write`, `subscriptions:read`, `orders:read`; add `products:read` for `polar:check` and `webhooks:read` + `webhooks:write` for `polar:webhook`, and take those off afterwards. Add to `.env.local`:
   ```
   BILLING_PROVIDER=polar
   POLAR_SERVER=sandbox                          # production for live
   POLAR_ACCESS_TOKEN=polar_oat_...
   POLAR_PRODUCT_PRO_MONTH=...                   # one line per item of src/config/billing.ts
   ```
5. **The webhook.** Open a tunnel, then `npm run polar:webhook -- https://<your-tunnel>/api/webhooks/polar --write`: it registers the endpoint (format **Raw**, the ten events the handler knows) and writes its signing secret to `.env.local`. Restart `npm run dev`. (Or create the endpoint by hand in the dashboard with the events listed in `scripts/polar-setup.mjs`.)
6. **Check:** `npm run polar:check`. With `products:read` it also compares every product with `src/config/billing.ts` (interval, price, currency): a merchant of record's review compares your site with what is charged, so a mismatch is worth knowing now.
7. **Try it.** Same as Paddle step 7; on Polar's page pay with `4242 4242 4242 4242`. You come back to `/billing/success`.

## Switching provider

`BILLING_PROVIDER` is read on every request: change it in your host's environment and redeploy (or restart). What that does, and does not do:

| | |
|---|---|
| **New checkouts** | go to the provider `BILLING_PROVIDER` names, and only to it. |
| **Existing subscribers** | stay with the provider that bills them. Their subscription keeps renewing there, its webhooks keep updating `billing_subscriptions`, their portal link opens **that** provider's portal, and `getEntitlement` / `hasPurchased` answer the same as before. |
| **Double billing** | cannot happen through the template: a user with a running, past-due or paused subscription (at either provider) gets `409 already_subscribed`. They change plan or cancel in their portal; once it has ended they can subscribe again, now at the new provider. |
| **Both webhooks** | keep running. Keep the old provider's `*_WEBHOOK_SECRET` and API key in `.env` for as long as it has subscribers; without them its renewals and cancellations stop reaching you. |
| **What you can drop** | after the switch the old provider needs only its server side (API key, webhook secret; for Paddle also `PADDLE_APP_TAG`). Its price / product ids and, for Paddle, the browser token are not needed any more. |
| **Moving subscribers across** | is **not** automatic (there is no way to move a card between merchants). The honest options: leave them where they are (they stay until they cancel), or ask them to cancel at the end of the period and subscribe again. |

A runbook for a switch that must not break anything:

1. `npm run billing:check` with both providers' variables in the environment: both "ready", and it says which takes new checkouts.
2. Test the new provider end to end in its **sandbox** (steps 4-7 of its set-up) before touching production.
3. Complete the new provider's review (domain / account) and put its **live** keys, ids and webhook in the production environment, with `BILLING_PROVIDER` still on the old one: nothing changes for buyers yet.
4. Buy your smallest plan at the new provider with a real card **and refund it**, from a test account of yours (set `BILLING_PROVIDER` for one deploy, or use a preview deployment).
5. Set `BILLING_PROVIDER` to the new one in production. To go back, set it to the old one again; nothing is lost either way.

If you set neither provider's variables for one of them, the template simply never uses it. If **both** are configured and `BILLING_PROVIDER` is empty, new checkouts are refused (`503 billing_not_configured`, the reason is in the server log) rather than guessed.

## Use it in your app

```ts
import { getEntitlement, hasPurchased } from "@/lib/billing/entitlements";
import { createClient } from "@/utils/supabase/server";

const supabase = await createClient();                  // carries the user's session: Row Level Security keeps other users' rows out
const { data: { user } } = await supabase!.auth.getUser();
if (!user) redirect("/login");

const entitlement = await getEntitlement(supabase!, user.id);
if (!entitlement.active) redirect("/pricing");          // active = running subscription (active or in a trial)
if (entitlement.planKey === "team") { /* team-only feature */ }
entitlement.cancelAtPeriodEnd;                          // the user cancelled: still active until currentPeriodEnd
entitlement.pastDue;                                    // the last payment failed and the provider is retrying: YOU decide whether to keep access
entitlement.provider;                                   // "paddle" | "polar": who bills it (you rarely need this)

await hasPurchased(supabase!, user.id, "credits_100");            // a one-time product from billingConfig.products, whichever provider took the payment
```

What a plan *allows* is your code, keyed on `planKey`. To grant something when a payment arrives (credits, a licence), add it where the webhook records the payment: `applyTransaction` in `src/lib/billing/paddle/webhook.ts` and `applyPolarOrder` in `src/lib/billing/polar/webhook.ts` (it runs once per payment; `billing_transactions` is your ledger).

The data model, if you read it from the browser: Row Level Security lets a user read only the rows with their own `user_id`; `billing_webhook_events` is not readable from the browser at all. Amounts are the provider's minor units (cents). A Polar order's refund is kept as one adjustment per order (`refund_<orderId>`) that only grows.

## How it stays safe

- **A payment is credited through what the SERVER linked, never through anything the browser sends.**
  Paddle: before a checkout opens, the server finds or creates the Paddle customer for the signed-in user's e-mail and links it (`billing_customers.paddle_customer_id`, UNIQUE: a Paddle customer can never belong to two users); a payment from a customer the server never linked is ignored.
  Polar: the server creates every checkout with `external_customer_id = <user id>`, and a payload is credited to that id only (not to its metadata, not to its e-mail); one without it is ignored.
- **Paddle: a checkout needs a verified e-mail address** (`403 email_not_verified` otherwise). A Paddle customer is found by e-mail and is shared by every app on the account, so linking one to an address nobody confirmed would let a stranger who signs up with it open that customer's portal. Keep e-mail confirmation on in Supabase (Authentication > Providers > Email), or sign users in with OAuth, which confirms the address. Polar does not need this: its customer is the user id.
- **Only your products count.** An event whose price (Paddle) or product (Polar) is not one of the ids in your environment is ignored (it belongs to another app). Paddle sends every destination the events of the whole account; for that reason Paddle also needs your `PADDLE_APP_TAG`.
- **The server creates the checkout.** The browser names *what* to buy (`pro` + `month`, never an id, a price, a customer or a provider); the id, the quantity (1) and the customer are fixed by `/api/billing/checkout`.
- **Signatures are checked on the raw body.** Paddle: `Paddle-Signature`, several `h1` values accepted (secret rotation), five-minute tolerance. Polar: [Standard Webhooks](https://www.standardwebhooks.com) (`webhook-id`, `webhook-timestamp`, `webhook-signature`), both of Polar's key schemes, five-minute tolerance. No secret configured means the webhook refuses, never accepts.
- **Idempotent and order-safe.** A delivery is claimed once per provider (the primary key (`provider`, `event_id`) refuses the second); a failed one is retried by the provider and taken over again with one conditional update; an older subscription state, and an older refund state, never overwrite a newer one (one conditional `UPDATE ... WHERE event_occurred_at <= new`, comparing instants).
- **The browser only follows an `https://` checkout URL** from the server, never something that would run in the page.
- **A key of the wrong environment is refused** (Paddle: a sandbox key with `NEXT_PUBLIC_PADDLE_ENVIRONMENT=production`, or the reverse). Polar defaults to its sandbox unless `POLAR_SERVER=production` exactly.
- **Row Level Security**: users read only their own billing rows; no browser role can write any of them (there is no write policy, and the privileges are revoked as well); the webhook log is closed to the browser. Writes use the service role, on the server only (`src/utils/supabase/admin.ts` imports `server-only`).

If several apps share one Paddle account (the usual case when you clone the template), give each its own `PADDLE_APP_TAG` and its own notification destination: their events reach each other's webhooks and are ignored.

## Deleting a user

Deleting a Supabase user removes their `billing_*` rows (cascade) but **not their subscription**: the provider keeps charging. Cancel it first, from your account-deletion code (Paddle: `POST /subscriptions/{id}/cancel` with `{ "effective_from": "immediately" }`; Polar: `DELETE /v1/subscriptions/{id}`, which needs the `subscriptions:write` scope), or send the user to "Manage billing" before they delete the account. `getEntitlement(supabase, userId)` returns the `provider` and the `subscriptionId`: they tell you which call. The cascade also deletes the payment rows: if you need them for accounting, export them first or change the foreign keys to `on delete set null`.

## Go live

**Paddle**

1. Paddle verifies you (identity and business), then the **domain you sell on must be approved** (Paddle > Checkout > Website approval). Until then the checkout does not open on that domain. What the review reads on the live site (most are approved automatically; a manual review takes about 5-7 business days): a clear description of the product, its key features and **pricing** (`/pricing` is made for this), **Terms of Service, Refund Policy and Privacy Policy** reachable from the navigation or footer with your company's name in the Terms, HTTPS, a live site, nothing that reads as a pre-sale. Check Paddle's [Acceptable Use Policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) too.
2. Create live credentials (a `pdl_live_` API key, a `live_` client-side token) and keep them in a separate file, not in `.env.local`:
   ```bash
   # .env.production.local: PADDLE_API_KEY=pdl_live_..., NEXT_PUBLIC_PADDLE_ENVIRONMENT=production, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=live_..., PADDLE_APP_TAG=my-app
   node --no-warnings --env-file=.env.production.local scripts/paddle-setup.mjs catalog --live --yes --write --out=.env.production.local
   node --no-warnings --env-file=.env.production.local scripts/paddle-setup.mjs webhook-create https://yourdomain.com/api/webhooks/paddle --live --yes --write --out=.env.production.local
   ```
   On the live account every command that changes something needs `--live --yes`, and the webhook destination is created **inactive**; activate it after the deploy: `... webhook-activate <id> --live --yes`.
3. Push the migration to the production project (`npm run db:push`), set the environment on your host (everything in `.env.production.local` plus the Supabase variables and `SUPABASE_SERVICE_ROLE_KEY`), deploy. `https://yourdomain.com/api/webhooks/paddle` must answer `401` to an unsigned request.
4. Buy your smallest plan with a real card and refund it from the Paddle dashboard; check `/billing` and the `billing_*` rows.

**Polar**

1. Create the **production** organization at <https://polar.sh> and submit its account review (business details, identity, payout account). Read the [acceptable-use policy](https://polar.sh/docs/merchant-of-record/acceptable-use) first: a restricted category can be refused at onboarding, and the product description must be the true one. Public pages linked from the footer: pricing, Terms, Privacy, Refund & cancellation, contact; prices on the site must equal the Polar products (`npm run polar:check`).
2. In production: create the products (`npm run polar:catalog` with `POLAR_SERVER=production` lists them), a production access token, and the webhook (`node --no-warnings --env-file=.env.production.local scripts/polar-setup.mjs webhook-create https://yourdomain.com/api/webhooks/polar --live --yes --write --out=.env.production.local`). Environment on your host: `POLAR_SERVER=production`, the token, the secret, the `POLAR_PRODUCT_*` ids.
3. `https://yourdomain.com/api/webhooks/polar` must answer `401` to an unsigned request.
4. After the first real sale request a small payout right away: the full review happens before the first payout, so find problems while the balance is small.

## Troubleshooting

| You see | Cause |
|---|---|
| `503 billing_not_configured` (checkout, portal, webhook) | `npm run billing:check` says which provider is meant and what is missing. The exact reason is in the server log (`[billing] ...`, `[paddle] ...`, `[polar] ...`). |
| `503 billing_not_configured` although one provider works | Both are configured and `BILLING_PROVIDER` is empty, or it names a provider that is not fully configured. |
| `503 supabase_admin_not_configured` | `SUPABASE_SERVICE_ROLE_KEY` (or the Supabase URL) is not set: the webhooks and the checkout need to write. |
| A webhook answers `401 invalid_signature` | The `*_WEBHOOK_SECRET` is not the secret of the endpoint the provider is calling (each endpoint has its own), or the app was not restarted after you changed it. |
| A provider shows deliveries failing with `500` | Read the server log; providers retry for days. Fix the cause and the deliveries are applied. `billing_webhook_events` keeps the payload and the error. |
| A webhook answers `200` but nothing appears | The event was `ignored`: see its `note` in `billing_webhook_events` (`unknown_customer`, `no_customer`, `not_our_price` / `not_our_product`, `other_app`, `unhandled_event_type`). |
| `/billing/success` waits a minute, then says it is slow | The webhook has not arrived. Is the endpoint active, its URL reachable, the tunnel up? The page asks the server to sync, so a paid plan still appears. |
| `403 email_not_verified` | Paddle only: the user's e-mail address is not confirmed in Supabase. |
| `409 already_subscribed` | One subscription at a time, at either provider: changing plan or cancelling goes through "Manage billing". |
| `409 customer_conflict` | Paddle only: two accounts in your database share one e-mail address, and the Paddle customer is already linked to the other one (the UNIQUE constraint on `paddle_customer_id` said no). |
| "Manage billing" opens the old provider | Correct: that is where this user's subscription lives. |
| The Paddle overlay does not open on your live domain | The domain is not approved yet. |
| A button says "Not available yet." | The active provider has no id for that item in `.env` (`npm run paddle:catalog -- --write`, or paste the Polar product id). |

## Tests

- `npm test` runs the unit tests (Node 22.18+ is needed: they run the TypeScript directly): both signatures (Polar's is cross-checked against the reference `standardwebhooks` library when it is installed), the configuration rules, the provider choice, the checkout request, every webhook flow of both providers (subscription lifecycle, payments, refunds, duplicates, out-of-order, failures and redelivery), the sync, the Supabase store and customer links over an in-memory fake, the route handlers of **both providers, including a switch under existing subscribers**, the checkout button's decision, the pricing table, and that the scripts repeat the library's rules faithfully.
- The fake does not run SQL. The migration was applied to a real Postgres engine ([PGlite](https://pglite.dev)) with a stub of Supabase's `auth` schema and roles when this template was built: a user reads only their own rows (whichever provider they come from), no browser role can write, the webhook log is invisible to the browser, the constraints hold (provider check, composite keys, one Paddle customer per user, many users without one) and the guarded updates behave. Repeat it after you change the migration (`npm run db:reset`, then the same checks by hand against your local Supabase).
- `npm run typecheck` and `npm run lint` as usual.
