create table if not exists accounts (
  id bigserial primary key,
  username text,
  email text,
  wallet text,
  password_hash text,
  avatar bytea,
  avatar_v int not null default 0,
  ref_code text,
  referred_by bigint references accounts(id),
  created_at timestamptz not null default now()
);
create unique index if not exists accounts_username on accounts (lower(username)) where username is not null;
create unique index if not exists accounts_email on accounts (lower(email)) where email is not null;
create unique index if not exists accounts_wallet on accounts (lower(wallet)) where wallet is not null;
create unique index if not exists accounts_ref on accounts (lower(ref_code)) where ref_code is not null;

create table if not exists sessions (
  token_hash text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists email_codes (
  id bigserial primary key,
  email text not null,
  purpose text not null,
  account_id bigint,
  code_hash text not null,
  attempts int not null default 0,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists email_codes_email on email_codes (lower(email), created_at);

create table if not exists wallet_challenges (
  nonce text primary key,
  address text not null,
  purpose text not null,
  account_id bigint,
  message text not null,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table if not exists wallet_links (
  account_id bigint primary key references accounts(id) on delete cascade,
  address text not null,
  verified_at timestamptz not null default now(),
  balance numeric,
  read_at timestamptz
);

-- Every movement of credit is a line here; the balance is their sum. Lines are never edited.
-- (kind, ref) is unique so a webhook or a retry can never credit or charge twice.
create table if not exists ledger (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  kind text not null,
  credits numeric(20,6) not null,
  source text,
  model text,
  ref text,
  key_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists ledger_account on ledger (account_id, created_at desc);
create unique index if not exists ledger_kind_ref on ledger (kind, ref) where ref is not null;

create table if not exists holds (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  credits numeric(20,6) not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists holds_account on holds (account_id);

create table if not exists conversations (
  account_id bigint not null references accounts(id) on delete cascade,
  id text not null,
  title text,
  door text,
  messages jsonb not null,
  updated_at bigint not null,
  primary key (account_id, id)
);

create table if not exists media (
  id text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  kind text not null,
  mime text not null,
  path text,
  prompt text,
  model text,
  credits numeric(20,6),
  created_at timestamptz not null default now()
);
create index if not exists media_account on media (account_id, kind, created_at desc);

create table if not exists video_jobs (
  id text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  upstream_id text,
  model text not null,
  prompt text,
  status text not null,
  hold_id bigint,
  reserved numeric(20,6),
  credits numeric(20,6),
  error text,
  media_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists deposits (
  id text primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  provider_id text,
  crypto text not null,
  address text,
  amount_crypto text,
  amount_usd numeric(20,2) not null,
  expires_at timestamptz,
  stage text not null default 'waiting',
  status text,
  received_usd numeric(20,6) not null default 0,
  credited_usd numeric(20,6) not null default 0,
  credits numeric(20,6) not null default 0,
  credited_at timestamptz,
  tx_hash text,
  last_callback_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists deposits_provider on deposits (provider_id) where provider_id is not null;

create table if not exists api_keys (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  daily_cap numeric(20,6),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists roadmap_requests (
  id bigserial primary key,
  text text not null,
  contact text,
  ip text,
  created_at timestamptz not null default now()
);

-- Launch settings the panel edits: the mint and the links that only exist once it does.
-- One row per setting so saving one never rewrites another. Environment variables stay as
-- the fallback, so a deployment with nothing saved here behaves exactly as before.
create table if not exists settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
