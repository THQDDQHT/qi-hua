create table anonymous_clients (
  id uuid primary key,
  token_hash bytea unique not null,
  status text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table daily_client_quotas (
  client_id uuid not null,
  quota_date date not null,
  success_count smallint not null default 0,
  reserved_count smallint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (client_id, quota_date)
);

create table daily_ip_quotas (
  ip_hash bytea not null,
  quota_date date not null,
  success_count smallint not null default 0,
  reserved_count smallint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip_hash, quota_date)
);

create table generation_requests (
  id uuid primary key,
  client_id uuid not null,
  request_key text not null,
  ip_hash bytea not null,
  requested_count smallint not null,
  reserved_count smallint not null,
  success_count smallint not null default 0,
  status text not null,
  error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table anonymous_clients add constraint anonymous_clients_status_check check (status in ('active', 'disabled'));
alter table daily_client_quotas add constraint daily_client_counts_check check (success_count >= 0 and reserved_count >= 0);
alter table daily_ip_quotas add constraint daily_ip_counts_check check (success_count >= 0 and reserved_count >= 0);
alter table generation_requests add constraint generation_request_count_check check (requested_count between 1 and 4 and reserved_count >= 0 and success_count >= 0);
alter table generation_requests add constraint generation_request_status_check check (status in ('reserved', 'running', 'completed', 'partial', 'failed', 'expired'));

create unique index generation_requests_client_key_uidx on generation_requests (client_id, request_key);
create index generation_requests_expiry_idx on generation_requests (expires_at) where status in ('reserved', 'running');
