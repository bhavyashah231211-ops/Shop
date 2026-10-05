-- CBSystem Shop: one row per business. Run once in Supabase > SQL Editor.
create table if not exists public.cbs_shop_tenants (
  id         text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name       text not null,
  key_hash   text not null,                       -- SHA-256 of the staff key (the key itself is never stored)
  data       jsonb not null default '{}'::jsonb,  -- the whole shop: products, stock, sales, staff, settings
  version    bigint not null default 1,           -- bumps on every save; stops two tills overwriting each other blindly
  active     boolean not null default true,       -- false = subscription paused
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lock the table: browsers can never read it. Only the cbs-biz function (service role) can.
alter table public.cbs_shop_tenants enable row level security;
revoke all on public.cbs_shop_tenants from anon, authenticated;
