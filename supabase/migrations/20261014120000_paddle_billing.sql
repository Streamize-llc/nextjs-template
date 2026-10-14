-- Paddle billing (docs: PADDLE.md).
--
--   billing_customers      which Paddle customer is which user. Created by the server BEFORE a checkout opens, so a payment is
--                          credited to a user through the customer id alone (never through anything the browser sends).
--   billing_subscriptions  one row per Paddle subscription, kept in step by the webhook. `event_occurred_at` makes it safe against
--                          events that arrive out of order: an older event never overwrites a newer one.
--   billing_transactions   every completed payment (subscription renewals and one-time purchases), with what has been refunded.
--   billing_adjustments    refunds and chargebacks Paddle reports against a transaction.
--   billing_webhook_events every webhook delivery, for idempotency (Paddle delivers at least once) and for debugging.
--
-- Everything here is written by the server with the service role (the webhook and the /api/billing routes). A signed-in user can only
-- READ their own rows: there is no insert / update / delete policy, so Row Level Security refuses every write from the browser.
-- Money amounts are Paddle's minor units (cents) as bigint; `currency` says which currency.

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
  paddle_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

-- ── subscriptions ────────────────────────────────────────────────────────────────────────────────────
create table public.billing_subscriptions (
  id                   text primary key,                  -- Paddle subscription id (sub_...)
  user_id              uuid not null references auth.users (id) on delete cascade,
  paddle_customer_id   text not null,
  status               text not null check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  plan_key             text,                              -- the plan in src/config/billing.ts this price belongs to (null: not one of ours)
  price_id             text not null,
  billing_interval     text,                              -- month | year | week | day
  quantity             integer not null default 1,
  currency             text,
  unit_amount          bigint,                            -- price per period in minor units
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,    -- Paddle scheduled_change.action = 'cancel'
  scheduled_change     jsonb,
  canceled_at          timestamptz,
  event_occurred_at    timestamptz not null,              -- occurred_at of the newest event applied
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index billing_subscriptions_user_idx on public.billing_subscriptions (user_id);
create index billing_subscriptions_customer_idx on public.billing_subscriptions (paddle_customer_id);
create trigger billing_subscriptions_updated_at before update on public.billing_subscriptions
  for each row execute function public.billing_set_updated_at();

-- ── transactions ─────────────────────────────────────────────────────────────────────────────────────
create table public.billing_transactions (
  id                 text primary key,                    -- Paddle transaction id (txn_...)
  user_id            uuid not null references auth.users (id) on delete cascade,
  paddle_customer_id text not null,
  subscription_id    text,
  status             text not null,
  origin             text,                                -- api | subscription_recurring | web | ...
  price_id           text,
  item_key           text,                                -- plan or product key in src/config/billing.ts
  currency           text not null,
  subtotal           bigint not null default 0,
  tax                bigint not null default 0,
  total              bigint not null default 0,           -- what the customer paid (grand total)
  refunded           bigint not null default 0,           -- sum of the approved refunds and chargebacks
  invoice_number     text,
  billed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index billing_transactions_user_idx on public.billing_transactions (user_id, billed_at desc);
create trigger billing_transactions_updated_at before update on public.billing_transactions
  for each row execute function public.billing_set_updated_at();

-- ── adjustments (refunds, chargebacks) ───────────────────────────────────────────────────────────────
create table public.billing_adjustments (
  id             text primary key,                        -- Paddle adjustment id (adj_...)
  transaction_id text not null references public.billing_transactions (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  action         text not null,                           -- refund | chargeback | credit | ...
  status         text not null,                           -- pending_approval | approved | rejected | reversed
  currency       text not null,
  total          bigint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index billing_adjustments_transaction_idx on public.billing_adjustments (transaction_id);
create trigger billing_adjustments_updated_at before update on public.billing_adjustments
  for each row execute function public.billing_set_updated_at();

-- ── webhook events (idempotency) ─────────────────────────────────────────────────────────────────────
create table public.billing_webhook_events (
  event_id    text primary key,                           -- Paddle event id (evt_...)
  event_type  text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  status      text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  note        text,
  payload     jsonb not null
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
