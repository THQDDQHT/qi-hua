alter table generation_requests
  add column operation text,
  add column prompt text,
  add column size text,
  add column quality text,
  add column reference_manifest jsonb,
  add column result_manifest jsonb,
  add column execution_id uuid,
  add column attempt_count smallint not null default 0,
  add column started_at timestamptz,
  add column heartbeat_at timestamptz,
  add column lease_expires_at timestamptz,
  add column result_expires_at timestamptz,
  add column artifacts_deleted_at timestamptz,
  add column updated_at timestamptz not null default now();

update generation_requests
set lease_expires_at = expires_at
where status = 'running' and lease_expires_at is null;

alter table generation_requests
  add constraint generation_request_operation_check check (
    operation is null or operation in ('generation', 'edit')
  ),
  add constraint generation_request_quality_check check (
    quality is null or quality in ('auto', 'high', 'medium', 'low')
  ),
  add constraint generation_request_async_input_check check (
    operation is null
    or (
      prompt is not null and char_length(prompt) between 1 and 4000
      and size is not null and char_length(size) between 1 and 32
      and quality is not null
      and (
        (operation = 'generation' and reference_manifest is null)
        or (
          operation = 'edit' and reference_manifest is not null
          and jsonb_typeof(reference_manifest) = 'object'
        )
      )
    )
  ),
  add constraint generation_request_manifest_check check (
    result_manifest is null or jsonb_typeof(result_manifest) = 'array'
  ),
  add constraint generation_request_attempt_count_check check (attempt_count >= 0);

create index generation_requests_async_outbox_idx
  on generation_requests (status, expires_at, lease_expires_at, created_at)
  where operation is not null and status in ('reserved', 'running');

create index generation_requests_result_expiry_idx
  on generation_requests (result_expires_at, id)
  where result_expires_at is not null and artifacts_deleted_at is null;
