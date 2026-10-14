-- Billing for Paddle AND Polar (docs: BILLING.md).
--
--   billing_customers      what links a user to the providers. Paddle customers are found by e-mail and shared by every app on the account,
--                          so the server records which one is the user's (`paddle_customer_id`, UNIQUE: it can never belong to two users).
--                          A Polar customer IS the user (the server sets `external_customer_id = user id` at checkout), so only the moment
--                          of the first Polar checkout is kept (`polar_linked_at`). Both are written BEFORE a checkout opens, by the server.
--   billing_subscriptions  one row per subscription of either provider, kept in step by the webhooks. `event_occurred_at` makes it safe
--                          against events that arrive out of order: an older state never overwrites a newer one.
--   billing_transactions   every completed payment (Paddle transaction, Polar order: renewals and one-time purchases), with what has been refunded.
--   billing_adjustments    refunds and chargebacks reported against a transaction (for Polar: one row per order that only grows).
--   billing_webhook_events every webhook delivery, for idempotency (providers deliver at least once) and for debugging.
--
-- The primary key of every table is (provider, id): a Paddle id and a Polar id can never collide, and a user can have rows of both.
-- Everything here is written by the server with the service role (the webhooks and the /api/billing routes). A signed-in user can only
-- READ their own rows: there is no insert / update / delete policy, so Row Level Security refuses every write from the browser.
-- Money amounts are the provider's minor units (cents) as bigint; `currency` says which currency.

create or replace function public.billing_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── customers ────────────────────────────────────────────────────────────────────────────────────────
create table public.billing_customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  paddle_customer_id text unique,                          -- null until the user opened a Paddle checkout (several nulls are fine)
  polar_linked_at    timestamptz,                          -- null until the user opened a Polar checkout
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger billing_customers_updated_at before update on public.billing_customers
  for each row execute function public.billing_set_updated_at();

-- ── subscriptions ────────────────────────────────────────────────────────────────────────────────────
create table public.billing_subscriptions (
  provider             text not null check (provider in ('paddle', 'polar')),
  id                   text not null,                     -- the provider's subscription id
  user_id              uuid not null references auth.users (id) on delete cascade,
  customer_id          text not null,                     -- the provider's customer id
  status               text not null check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  plan_key             text,                              -- the plan in src/config/billing.ts this price / product belongs to (null: not a plan)
  price_id             text not null,                     -- what was bought, in the provider's terms: a Paddle price id, a Polar product id
  billing_interval     text,                              -- month | year | week | day
  quantity             integer not null default 1,
  currency             text,
  unit_amount          bigint,                            -- price per period in minor units
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,    -- Paddle scheduled_change.action = 'cancel'; Polar cancel_at_period_end
  scheduled_change     jsonb,
  canceled_at          timestamptz,
  event_occurred_at    timestamptz not null,              -- when the provider produced the newest state applied
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (provider, id)
);
create index billing_subscriptions_user_idx on public.billing_subscriptions (user_id);
create index billing_subscriptions_customer_idx on public.billing_subscriptions (provider, customer_id);
create trigger billing_subscriptions_updated_at before update on public.billing_subscriptions
  for each row execute function public.billing_set_updated_at();

-- ── transactions ─────────────────────────────────────────────────────────────────────────────────────
create table public.billing_transactions (
  provider        text not null check (provider in ('paddle', 'polar')),
  id              text not null,                          -- Paddle transaction id (txn_...) or Polar order id
  user_id         uuid not null references auth.users (id) on delete cascade,
  customer_id     text not null,
  subscription_id text,
  status          text not null,                          -- completed: a payment that went through (a refund shows in `refunded`)
  origin          text,                                   -- Paddle: api | subscription_recurring | web ...; Polar: purchase | subscription_create | subscription_cycle ...
  price_id        text,
  item_key        text,                                   -- plan or product key in src/config/billing.ts
  currency        text not null,
  subtotal        bigint not null default 0,
  tax             bigint not null default 0,
  total           bigint not null default 0,              -- what the customer paid (tax included)
  refunded        bigint not null default 0,              -- sum of the approved refunds and chargebacks
  invoice_number  text,
  billed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (provider, id)
);
create index billing_transactions_user_idx on public.billing_transactions (user_id, billed_at desc);
create trigger billing_transactions_updated_at before update on public.billing_transactions
  for each row execute function public.billing_set_updated_at();

-- ── adjustments (refunds, chargebacks) ───────────────────────────────────────────────────────────────
create table public.billing_adjustments (
  provider          text not null check (provider in ('paddle', 'polar')),
  id                text not null,                        -- Paddle adjustment id (adj_...), or refund_<order id> for Polar
  transaction_id    text not null,
  user_id           uuid not null references auth.users (id) on delete cascade,
  action            text not null,                        -- refund | chargeback | credit | ...
  status            text not null,                        -- pending_approval | approved | rejected | reversed
  currency          text not null,
  total             bigint not null default 0,
  event_occurred_at timestamptz not null,                 -- when the provider produced this state: a late older delivery must not undo a newer one
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (provider, id),
  foreign key (provider, transaction_id) references public.billing_transactions (provider, id) on delete cascade
);
create index billing_adjustments_transaction_idx on public.billing_adjustments (provider, transaction_id);
create trigger billing_adjustments_updated_at before update on public.billing_adjustments
  for each row execute function public.billing_set_updated_at();

-- ── webhook events (idempotency) ─────────────────────────────────────────────────────────────────────
create table public.billing_webhook_events (
  provider    text not null check (provider in ('paddle', 'polar')),
  event_id    text not null,                              -- Paddle event id (evt_...), or Polar's webhook-id header
  event_type  text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  status      text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  note        text,
  payload     jsonb not null,
  primary key (provider, event_id)
);

-- ── Row Level Security: read your own, write nothing ─────────────────────────────────────────────────
alter table public.billing_customers      enable row level security;
alter table public.billing_subscriptions  enable row level security;
alter table public.billing_transactions   enable row level security;
alter table public.billing_adjustments    enable row level security;
alter table public.billing_webhook_events enable row level security;

create policy "billing_customers: read own" on public.billing_customers
  for select to authenticated using (user_id = (select auth.uid()));
create policy "billing_subscriptions: read own" on public.billing_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "billing_transactions: read own" on public.billing_transactions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "billing_adjustments: read own" on public.billing_adjustments
  for select to authenticated using (user_id = (select auth.uid()));
-- billing_webhook_events: no policy at all = only the service role can touch it.

-- Defence in depth: the browser roles get no write privilege on these tables, and none at all on the webhook log.
revoke insert, update, delete, truncate on
  public.billing_customers, public.billing_subscriptions, public.billing_transactions, public.billing_adjustments
  from anon, authenticated;
revoke all on public.billing_webhook_events from anon, authenticated;
revoke all on public.billing_customers, public.billing_subscriptions, public.billing_transactions, public.billing_adjustments from anon;
