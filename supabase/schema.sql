-- EGX Portfolio Tracker — schema
-- Run this once in the Supabase SQL editor for a new project.
-- Safe to re-run: every statement is idempotent.

-- ── Per-user data (RLS-protected: only the owner can read/write) ──

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  type text not null check (type in ('buy', 'sell')),
  amount numeric not null check (amount > 0),
  -- Optional: number of shares/units this transaction was for. Doesn't
  -- apply to Clouds (cash, no share concept) - leave null there. When
  -- present, lets estimate.js value a position as (net shares held) x
  -- (live market price), which is more robust than scaling from whenever
  -- you last happened to confirm a value.
  shares numeric,
  txn_date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on transactions(user_id);

-- Existing databases: add the column if it's not there yet.
alter table transactions add column if not exists shares numeric;

create table if not exists current_values (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  value numeric not null check (value >= 0),
  last_valued date not null default current_date,
  -- The market_prices.price for this ticker at the moment `value` was
  -- confirmed, if one was available. Lets the app estimate value between
  -- confirmations by scaling proportionally to the price change since -
  -- null if no market price existed for this ticker at that time (e.g.
  -- Clouds, C2O, T70), in which case no price-ratio estimate is shown.
  price_at_valuation numeric,
  primary key (user_id, ticker)
);

-- Existing databases: add the column if it's not there yet (no-op on a
-- fresh install where the create table above already included it).
alter table current_values add column if not exists price_at_valuation numeric;

create table if not exists targets (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  target_pct numeric not null check (target_pct >= 0 and target_pct <= 1),
  role text,
  primary key (user_id, ticker)
);

alter table transactions enable row level security;
alter table current_values enable row level security;
alter table targets enable row level security;

drop policy if exists "own transactions" on transactions;
create policy "own transactions" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own current_values" on current_values;
create policy "own current_values" on current_values
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own targets" on targets;
create policy "own targets" on targets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Public data (anyone can read, only the price-refresh Action can write) ──
-- The refresh script uses the Supabase SERVICE ROLE key, which bypasses RLS
-- entirely, so no write policy is defined here on purpose - regular users
-- (including visitors with no login) can only ever read this table.

create table if not exists market_prices (
  ticker text primary key,
  price numeric not null,
  currency text not null default 'EGP',
  source text not null,
  is_estimate boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table market_prices enable row level security;

drop policy if exists "anyone can read prices" on market_prices;
create policy "anyone can read prices" on market_prices
  for select using (true);

-- ── AI analysis notes (Rumble-derived), refreshed on request, not scheduled ──
-- Same RLS model as the rest of a user's data: owner-only.

create table if not exists analysis_notes (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  summary text not null,
  source text not null default 'therumble.app',
  refreshed_at timestamptz not null default now(),
  primary key (user_id, ticker)
);

alter table analysis_notes enable row level security;

drop policy if exists "own analysis_notes" on analysis_notes;
create policy "own analysis_notes" on analysis_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
