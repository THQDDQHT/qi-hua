alter table generation_requests
  add column if not exists quota_date date;

do $$
declare
  quota_date_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
  into quota_date_type
  from pg_attribute attribute
  where attribute.attrelid = 'generation_requests'::regclass
    and attribute.attname = 'quota_date'
    and not attribute.attisdropped;

  if quota_date_type is distinct from 'date' then
    raise exception 'generation_requests.quota_date must be date';
  end if;
end
$$;

with candidates as (
  select
    request.id,
    client_quota.quota_date,
    count(*) over (partition by request.id) as candidate_count
  from generation_requests request
  join daily_client_quotas client_quota
    on client_quota.client_id = request.client_id
  join daily_ip_quotas ip_quota
    on ip_quota.ip_hash = request.ip_hash
    and ip_quota.quota_date = client_quota.quota_date
  where request.quota_date is null
    and (
      request.status not in ('reserved', 'running')
      or (
        client_quota.reserved_count >= request.reserved_count
        and ip_quota.reserved_count >= request.reserved_count
      )
    )
), unique_candidates as (
  select id, quota_date
  from candidates
  where candidate_count = 1
)
update generation_requests request
set quota_date = candidate.quota_date
from unique_candidates candidate
where request.id = candidate.id;

do $$
begin
  if exists (select 1 from generation_requests where quota_date is null) then
    raise exception 'generation_requests.quota_date recovery requires exactly one candidate';
  end if;
end
$$;

alter table generation_requests
  add column if not exists payload_fingerprint bytea;

do $$
declare
  payload_fingerprint_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
  into payload_fingerprint_type
  from pg_attribute attribute
  where attribute.attrelid = 'generation_requests'::regclass
    and attribute.attname = 'payload_fingerprint'
    and not attribute.attisdropped;

  if payload_fingerprint_type is distinct from 'bytea' then
    raise exception 'generation_requests.payload_fingerprint must be bytea';
  end if;
end
$$;

update generation_requests
set payload_fingerprint = sha256(convert_to(
  'infinite-canvas/legacy-generation-request/v1/' || lower(id::text),
  'UTF8'
))
where payload_fingerprint is null;

do $$
declare
  cleaned_count bigint;
begin
  update generation_requests
  set error_code = null
  where error_code is not null
    and (
      status not in ('partial', 'failed')
      or error_code not in (
        'PROVIDER_REJECTED',
        'PROVIDER_TIMEOUT',
        'SERVICE_UNAVAILABLE'
      )
    );
  get diagnostics cleaned_count = row_count;
  raise notice 'cleared % unsupported generation request error codes', cleaned_count;
end
$$;

alter table generation_requests
  alter column quota_date drop default,
  alter column quota_date set not null,
  alter column payload_fingerprint drop default,
  alter column payload_fingerprint set not null;

alter table generation_requests
  drop constraint generation_request_count_check;

alter table generation_requests
  add constraint generation_request_count_check check (
    requested_count between 1 and 4
    and reserved_count between 0 and requested_count
    and success_count between 0 and requested_count
    and reserved_count + success_count <= requested_count
  );

alter table generation_requests
  add constraint generation_request_payload_fingerprint_check check (
    octet_length(payload_fingerprint) = 32
  );

alter table generation_requests
  add constraint generation_request_state_check check (
    (
      status in ('reserved', 'running')
      and reserved_count = requested_count
      and success_count = 0
      and completed_at is null
      and error_code is null
    )
    or (
      status = 'completed'
      and reserved_count = 0
      and success_count = requested_count
      and completed_at is not null
      and error_code is null
    )
    or (
      status = 'partial'
      and reserved_count = 0
      and success_count > 0
      and success_count < requested_count
      and completed_at is not null
    )
    or (
      status = 'failed'
      and reserved_count = 0
      and success_count = 0
      and completed_at is not null
    )
    or (
      status = 'expired'
      and reserved_count = 0
      and success_count = 0
      and completed_at is not null
      and error_code is null
    )
  );

alter table generation_requests
  add constraint generation_request_error_code_check check (
    error_code is null
    or (
      status in ('partial', 'failed')
      and error_code in (
        'PROVIDER_REJECTED',
        'PROVIDER_TIMEOUT',
        'SERVICE_UNAVAILABLE'
      )
    )
  );
