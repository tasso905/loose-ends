-- S2 hardening (tester defects S2-1, S2-2, S2-3, S2-5; retry cap; timeout event). Additive only.
--
-- Shape chosen: the pipeline's writes are SECURITY DEFINER functions with explicit auth.uid()
-- ownership checks and a pinned search_path, and guard triggers enforce the trust invariants on
-- EVERY write path, including direct PostgREST writes by `authenticated`:
--
--   * Only the pipeline creates retryable attempts. `extractions.via_pipeline` is forced false on
--     any insert by `authenticated` (default true for trusted writers); retry, stage, complete, fail and poll act on pipeline
--     attempts only. A directly inserted source + failed attempt can never become a model run (S2-1a).
--   * `authenticated` cannot change an attempt's status, stage or trace columns (S2-1b), and cannot
--     replace a source's text (only clear it) or its kind/reference date (S2-1c). Over-limit text
--     never reaches extraction_context (S2-1c, defence in depth).
--   * Rule 1 at the database: every quote stored in extraction_items.payload, in evidence rows and
--     in a brief's source lines must occur verbatim in the source text, whoever writes it (S2-3).
--   * set_extraction_stage moves forward only (reading → finding → checking); runExtraction claims
--     an attempt with reading → finding, so a second run of the same attempt stops before the
--     model call (S2-2).
--
-- Why not revoke table writes for `authenticated`: S0's forget_thread and S3's review functions
-- are SECURITY INVOKER and write these tables, and the S0 live suite seeds data through the user's
-- own client. Triggers keep those working while closing the bypasses. Why not the service role:
-- CLAUDE.md limits it to cron/daily, account deletion and inbound email.
-- SUPERSEDED by 20261021115926_write_model_definer.sql: those functions are now definer and
-- direct writes are revoked; the guards below remain as a second layer.
--
-- Residual (reported): an owner can still insert their own extraction_items/evidence rows directly,
-- but every quote in them must be verbatim in their own source (rule 1 holds); titles and labels of
-- such self-authored rows are not pipeline output. Closing that needs the direct INSERT grants
-- revoked once the S0 live seeds move to the service role.
--
-- Trigger checks use current_user: inside a SECURITY DEFINER function it is the function owner,
-- so the restrictions apply to direct writes and to invoker functions running as `authenticated`.

-- 1. Pipeline attempts -------------------------------------------------------------------------

-- True for attempts written by a trusted writer: the pipeline's definer functions, the service role
-- (seeds, admin) or a migration. Any insert by `authenticated` (a direct PostgREST write) is forced
-- false by extractions_guard, and such rows are invisible to retry, stage, complete, fail and poll.
alter table public.extractions add column via_pipeline boolean not null default true;

-- Pipeline attempts started for a source (start = 1, each Try again + 1). Kept on the source, not
-- counted from extraction rows, so deleting old attempts cannot reset the retry cap.
alter table public.sources add column pipeline_attempts int not null default 0;
update public.sources s set pipeline_attempts = (select count(*) from public.extractions e where e.source_id = s.id);

/** Retries allowed per source after the first attempt (user decision pending; default on). */
create function private.max_retries_per_source() returns int
language sql immutable set search_path = '' as $$ select 3 $$;

create function private.is_blank(t text) returns boolean
language sql immutable set search_path = '' as $$
  select t is null or t ~ '^[[:space:]   -​    　﻿]*$'
$$;

-- 2. Rule 1 helpers ----------------------------------------------------------------------------

-- Verbatim, or verbatim after S0's quote normalization (typographic quotes and dashes folded,
-- whitespace collapsed, case folded): PRD rule 1 matches with normalized whitespace.
create function private.quote_in_text(p_quote text, p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select p_quote is not null and private.norm_quote(p_quote) <> '' and p_text is not null
    and (position(p_quote in p_text) > 0 or position(private.norm_quote(p_quote) in private.norm_quote(p_text)) > 0)
$$;

-- Every `quote` in a jsonb array of evidence objects occurs in the text. A missing or empty
-- array passes (such a payload is never displayed: the reader requires at least one quote).
create function private.evidence_verified(p_evidence jsonb, p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_evidence is null or jsonb_typeof(p_evidence) <> 'array' then true
    else not exists (
      select 1 from jsonb_array_elements(p_evidence) el
      where jsonb_typeof(el) <> 'object' or not private.quote_in_text(el ->> 'quote', p_text)
    )
  end
$$;

-- Every source-basis brief line has a quote that occurs in the text.
create function private.brief_verified(p_brief jsonb, p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select p_brief is null or jsonb_typeof(p_brief) <> 'object' or not exists (
    select 1 from jsonb_each(p_brief) sec, jsonb_array_elements(case when jsonb_typeof(sec.value) = 'array' then sec.value else '[]'::jsonb end) el
    where jsonb_typeof(el) = 'object' and el ->> 'basis' = 'source' and not private.quote_in_text(el ->> 'quote', p_text)
  )
$$;

-- 3. Guard triggers ----------------------------------------------------------------------------
-- BEFORE triggers guard columns (and force via_pipeline). Quote checks run in AFTER triggers named
-- zz_* so CHECK and foreign-key errors are reported first, as before.

create function private.extractions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if current_user = 'authenticated' then
      new.via_pipeline := false;
    end if;
    return new;
  end if;
  if current_user = 'authenticated' and (
       new.status is distinct from old.status or new.stage is distinct from old.stage
       or new.via_pipeline is distinct from old.via_pipeline or new.model is distinct from old.model
       or new.prompt_version is distinct from old.prompt_version or new.schema_version is distinct from old.schema_version
       or new.input_tokens is distinct from old.input_tokens or new.output_tokens is distinct from old.output_tokens
       or new.latency_ms is distinct from old.latency_ms or new.error is distinct from old.error
       or new.source_id is distinct from old.source_id or new.user_id is distinct from old.user_id
       or new.created_at is distinct from old.created_at) then
    raise exception 'extraction lifecycle columns are written by the pipeline only' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger extractions_guard before insert or update on public.extractions
  for each row execute function private.extractions_guard();

create function private.sources_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    if new.text_content is distinct from old.text_content and new.text_content is not null then
      raise exception 'source text cannot be replaced' using errcode = '42501';
    end if;
    if new.kind is distinct from old.kind or new.reference_date is distinct from old.reference_date
       or new.reference_date_source is distinct from old.reference_date_source
       or new.pipeline_attempts is distinct from old.pipeline_attempts
       or new.user_id is distinct from old.user_id or new.created_at is distinct from old.created_at then
      raise exception 'source columns are written by the pipeline only' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger sources_guard before update on public.sources
  for each row execute function private.sources_guard();

create function private.extraction_items_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- The review tray (S3) changes only review_status, thread_id and reviewed_at.
  if current_user = 'authenticated' and (
       new.payload is distinct from old.payload or new.band is distinct from old.band
       or new.confidence is distinct from old.confidence or new.suppression_hash is distinct from old.suppression_hash
       or new.item_index is distinct from old.item_index or new.extraction_id is distinct from old.extraction_id
       or new.user_id is distinct from old.user_id) then
    raise exception 'proposal columns are written by the pipeline only' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger extraction_items_guard before update on public.extraction_items
  for each row execute function private.extraction_items_guard();

-- Rule 1 checks (every writer, every path).
create function private.extractions_verify() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_text text;
begin
  -- A brief may always shrink (Forget's scrub); anything else new must quote the source.
  if new.brief is not null and (tg_op = 'INSERT' or (new.brief is distinct from old.brief
       and not (old.brief is not null and old.brief @> new.brief))) then
    select s.text_content into v_text from public.sources s where s.id = new.source_id and s.user_id = new.user_id;
    if not private.brief_verified(new.brief, v_text) then
      raise exception 'brief quote not in source' using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;
create trigger zz_extractions_verify after insert or update on public.extractions
  for each row execute function private.extractions_verify();

create function private.extraction_items_verify() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_text text;
begin
  if tg_op = 'INSERT' or new.payload is distinct from old.payload then
    select s.text_content into v_text
      from public.extractions e join public.sources s on s.id = e.source_id and s.user_id = e.user_id
      where e.id = new.extraction_id and e.user_id = new.user_id;
    if not private.evidence_verified(new.payload -> 'evidence', v_text) then
      raise exception 'proposal quote not in source' using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;
create trigger zz_extraction_items_verify after insert or update on public.extraction_items
  for each row execute function private.extraction_items_verify();

create function private.evidence_verify() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_text text;
begin
  if tg_op = 'INSERT' or new.quote is distinct from old.quote then
    if new.source_id is null then
      raise exception 'evidence needs its source to verify the quote' using errcode = '23514';
    end if;
    select s.text_content into v_text from public.sources s where s.id = new.source_id and s.user_id = new.user_id;
    if not private.quote_in_text(new.quote, v_text) then
      raise exception 'evidence quote not in source' using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;
create trigger zz_evidence_verify after insert or update on public.evidence
  for each row execute function private.evidence_verify();

revoke all on function private.max_retries_per_source(), private.is_blank(text), private.quote_in_text(text, text),
  private.evidence_verified(jsonb, text), private.brief_verified(jsonb, text),
  private.extractions_guard(), private.sources_guard(), private.extraction_items_guard(),
  private.extractions_verify(), private.extraction_items_verify(), private.evidence_verify()
from public, anon, authenticated;
-- Triggers run their functions without EXECUTE; the helpers are called inside them and inside the
-- definer functions below, which run as the owner.
grant execute on function private.quote_in_text(text, text), private.evidence_verified(jsonb, text),
  private.brief_verified(jsonb, text), private.is_blank(text) to authenticated;

-- 4. Pipeline functions as SECURITY DEFINER (replacing the invoker versions) --------------------

create or replace function public.start_source_extraction(
  p_kind text, p_text text, p_title text, p_reference_date date, p_now timestamptz,
  p_model text, p_prompt_version text, p_schema_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_ref date := p_reference_date;
  v_ref_source text := 'user';
  v_source uuid;
  v_extraction uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_kind not in ('paste', 'quick_add') then raise exception 'unsupported kind %', p_kind using errcode = '22023'; end if;
  if private.is_blank(p_text) or char_length(p_text) > 30000 then
    raise exception 'invalid text' using errcode = '22023';
  end if;
  if p_title is not null and char_length(p_title) > 120 then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_reference_date is not null and (p_reference_date < date '1900-01-01' or p_reference_date > date '2100-12-31') then
    raise exception 'invalid reference date' using errcode = '22023';
  end if;

  if v_ref is null then
    select p.timezone into v_tz from public.profiles p where p.id = v_uid;
    if not found then raise exception 'no profile' using errcode = '42501'; end if;
    v_ref := (p_now at time zone v_tz)::date;
    v_ref_source := 'defaulted';
  end if;

  -- One count per source submission; any failure below rolls the count back with it.
  if not public.consume_usage('extraction') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  insert into public.sources (user_id, kind, title, text_content, reference_date, reference_date_source, pipeline_attempts)
  values (v_uid, p_kind, nullif(btrim(p_title), ''), p_text, v_ref, v_ref_source, 1)
  returning id into v_source;

  insert into public.extractions (user_id, source_id, status, stage, model, prompt_version, schema_version, via_pipeline)
  values (v_uid, v_source, 'running', 'reading', p_model, p_prompt_version, p_schema_version, true)
  returning id into v_extraction;

  return jsonb_build_object('source_id', v_source, 'extraction_id', v_extraction);
end;
$$;

-- "Try again": a new pipeline attempt on the same source, not counted again (A3), at most
-- private.max_retries_per_source() times. Only the newest pipeline attempt can be retried; the
-- source row lock serializes concurrent clicks, and the losers get `already_started` so the
-- caller does not schedule a second run (S2-2).
create or replace function public.retry_extraction(
  p_extraction_id uuid, p_model text, p_prompt_version text, p_schema_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_source uuid;
  v_text text;
  v_latest uuid;
  v_latest_status text;
  v_attempts int;
  v_new uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select e.source_id into v_source from public.extractions e
    where e.id = p_extraction_id and e.user_id = v_uid and e.via_pipeline;
  if not found then return null; end if;

  select s.text_content, s.pipeline_attempts into v_text, v_attempts
    from public.sources s where s.id = v_source and s.user_id = v_uid for update;
  if not found or v_text is null or char_length(v_text) > 30000 then
    return jsonb_build_object('error', 'source_unavailable');
  end if;

  select e.id, e.status into v_latest, v_latest_status from public.extractions e
    where e.source_id = v_source and e.user_id = v_uid and e.via_pipeline
    order by e.created_at desc, e.id desc limit 1;
  if v_latest <> p_extraction_id then
    return jsonb_build_object('extraction_id', v_latest, 'already_started', true);
  end if;
  if v_latest_status <> 'failed' then
    return jsonb_build_object('error', 'not_failed', 'status', v_latest_status);
  end if;

  if v_attempts - 1 >= private.max_retries_per_source() then
    return jsonb_build_object('error', 'retry_limit');
  end if;

  insert into public.extractions (user_id, source_id, status, stage, model, prompt_version, schema_version, via_pipeline)
  values (v_uid, v_source, 'running', 'reading', p_model, p_prompt_version, p_schema_version, true)
  returning id into v_new;
  update public.sources s set pipeline_attempts = s.pipeline_attempts + 1 where s.id = v_source;
  return jsonb_build_object('extraction_id', v_new, 'already_started', false);
end;
$$;

-- Read-only, stays SECURITY INVOKER (RLS). Over-limit text is never handed to extract().
create or replace function public.extraction_context(p_extraction_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'status', e.status,
    'source_kind', s.kind,
    'source_text', case when char_length(s.text_content) <= 30000 then s.text_content end,
    'reference_date', s.reference_date,
    'reference_date_source', s.reference_date_source,
    'page_offsets', to_jsonb(s.page_offsets),
    'timezone', p.timezone,
    'display_name', p.display_name,
    'aliases', to_jsonb(p.aliases)
  )
  from public.extractions e
  join public.sources s on s.id = e.source_id and s.user_id = e.user_id
  join public.profiles p on p.id = e.user_id
  where e.id = p_extraction_id and e.user_id = (select auth.uid()) and e.via_pipeline
$$;

-- Forward-only stage moves. reading → finding is the claim: only one run gets true (S2-2).
create or replace function public.set_extraction_stage(p_extraction_id uuid, p_stage text) returns boolean
language sql security definer set search_path = '' as $$
  with u as (
    update public.extractions e set stage = p_stage
    where e.id = p_extraction_id and e.user_id = (select auth.uid()) and e.via_pipeline and e.status = 'running'
      and ((p_stage = 'finding' and e.stage = 'reading') or (p_stage = 'checking' and e.stage = 'finding'))
    returning 1
  )
  select exists (select 1 from u)
$$;

create or replace function public.complete_extraction(
  p_extraction_id uuid, p_model text, p_input_tokens int, p_output_tokens int, p_latency_ms int,
  p_raw_output jsonb, p_brief jsonb, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_source uuid;
  v_status text;
  v_item jsonb;
  v_ev jsonb;
  v_id uuid;
  v_reason text;
  v_inserted int := 0;
  v_suppressed int := 0;
  v_bands jsonb := '{}'::jsonb;
  v_raw jsonb := p_raw_output;
  v_brief jsonb := p_brief;
  v_forgot_quotes text[] := '{}';
  v_forgot_ranges int4range[] := '{}';
  v_idx int;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select e.source_id, e.status into v_source, v_status from public.extractions e
    where e.id = p_extraction_id and e.user_id = v_uid and e.via_pipeline for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'not_running'); end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_idx := (v_item ->> 'item_index')::int;
    select s.reason into v_reason from public.suppressions s
      where s.user_id = v_uid and s.suppression_hash = v_item ->> 'suppression_hash';
    if found then
      v_suppressed := v_suppressed + 1;
      if jsonb_typeof(v_raw) = 'object' and jsonb_typeof(v_raw -> 'items') = 'array'
         and v_idx < jsonb_array_length(v_raw -> 'items') then
        v_raw := jsonb_set(v_raw, array['items', v_idx::text], 'null'::jsonb, false);
      end if;
      if v_reason = 'forgotten' then
        select v_forgot_quotes || coalesce(array_agg(ev ->> 'quote'), '{}'),
               v_forgot_ranges || coalesce(array_agg(int4range((ev ->> 'start_offset')::int, (ev ->> 'end_offset')::int))
                 filter (where (ev ->> 'end_offset')::int > (ev ->> 'start_offset')::int), '{}')
          into v_forgot_quotes, v_forgot_ranges
          from jsonb_array_elements(coalesce(v_item -> 'evidence', '[]'::jsonb)) ev;
      end if;
      continue;
    end if;

    -- The guard triggers verify every quote (payload and evidence rows) against the source.
    insert into public.extraction_items (user_id, extraction_id, payload, confidence, band, suppression_hash, item_index)
    values (v_uid, p_extraction_id, v_item -> 'payload', (v_item ->> 'confidence')::numeric,
            v_item ->> 'band', v_item ->> 'suppression_hash', v_idx)
    returning id into v_id;

    for v_ev in select * from jsonb_array_elements(coalesce(v_item -> 'evidence', '[]'::jsonb)) loop
      insert into public.evidence (user_id, source_id, extraction_item_id, quote, start_offset, end_offset, page, match_kind, quote_hash)
      values (v_uid, v_source, v_id, v_ev ->> 'quote', (v_ev ->> 'start_offset')::int, (v_ev ->> 'end_offset')::int,
              (v_ev ->> 'page')::int, v_ev ->> 'match_kind', v_ev ->> 'quote_hash');
    end loop;
    v_inserted := v_inserted + 1;
    v_bands := jsonb_set(v_bands, array[v_item ->> 'band'], to_jsonb(coalesce((v_bands ->> (v_item ->> 'band'))::int, 0) + 1));
  end loop;

  if cardinality(v_forgot_quotes) > 0 then
    v_brief := private.scrub_brief(v_brief, v_forgot_quotes, v_forgot_ranges);
    if jsonb_typeof(v_raw) = 'object' and v_raw ? 'brief' then
      v_raw := jsonb_set(v_raw, '{brief}', 'null'::jsonb);
    end if;
  end if;

  update public.extractions e set
    status = 'succeeded', stage = null, model = p_model,
    input_tokens = p_input_tokens, output_tokens = p_output_tokens, latency_ms = p_latency_ms,
    raw_output = v_raw, brief = v_brief, error = null
  where e.id = p_extraction_id;

  return jsonb_build_object('ok', true, 'inserted', v_inserted, 'suppressed', v_suppressed, 'band_counts', v_bands);
end;
$$;

create or replace function public.fail_extraction(
  p_extraction_id uuid, p_error text, p_model text, p_latency_ms int, p_raw_output jsonb
) returns boolean
language sql security definer set search_path = '' as $$
  with u as (
    update public.extractions e set
      status = 'failed', stage = null, error = left(p_error, 64),
      model = coalesce(p_model, e.model), latency_ms = p_latency_ms, raw_output = p_raw_output
    where e.id = p_extraction_id and e.user_id = (select auth.uid()) and e.via_pipeline and e.status = 'running'
    returning 1
  )
  select exists (select 1 from u)
$$;

-- Poll read. `timed_out` is true only for the call that applied the 90 s rule, so exactly one
-- caller sends extraction_completed for it. `retry_available`: newest attempt, failed, under the cap.
create or replace function public.get_extraction(p_extraction_id uuid, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_timed_out int;
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  update public.extractions e set status = 'failed', stage = null, error = 'timeout'
    where e.id = p_extraction_id and e.user_id = v_uid and e.via_pipeline and e.status = 'running'
      and e.created_at < p_now - interval '90 seconds';
  get diagnostics v_timed_out = row_count;

  select jsonb_build_object(
    'id', e.id,
    'source_id', e.source_id,
    'status', e.status,
    'stage', e.stage,
    'error', e.error,
    'created_at', e.created_at,
    'timed_out', v_timed_out > 0,
    'brief', e.brief,
    'retry_available', e.status = 'failed'
      and not exists (select 1 from public.extractions n where n.source_id = e.source_id and n.user_id = v_uid
                        and n.via_pipeline and (n.created_at, n.id) > (e.created_at, e.id))
      and (select s.pipeline_attempts from public.sources s where s.id = e.source_id) - 1 < private.max_retries_per_source(),
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id, 'band', i.band, 'confidence', i.confidence,
          'review_status', i.review_status, 'thread_id', i.thread_id, 'payload', i.payload)
        order by case i.band when 'high' then 0 when 'medium' then 1 else 2 end, i.confidence desc, i.item_index)
      from public.extraction_items i
      where i.extraction_id = e.id and i.user_id = v_uid and i.band <> 'ignore'
    ), '[]'::jsonb)
  ) into v_out
  from public.extractions e
  where e.id = p_extraction_id and e.user_id = v_uid and e.via_pipeline;
  return v_out;
end;
$$;

revoke all on function
  public.start_source_extraction(text, text, text, date, timestamptz, text, text, text),
  public.retry_extraction(uuid, text, text, text),
  public.extraction_context(uuid),
  public.set_extraction_stage(uuid, text),
  public.complete_extraction(uuid, text, int, int, int, jsonb, jsonb, jsonb),
  public.fail_extraction(uuid, text, text, int, jsonb),
  public.get_extraction(uuid, timestamptz)
from public, anon;
grant execute on function
  public.start_source_extraction(text, text, text, date, timestamptz, text, text, text),
  public.retry_extraction(uuid, text, text, text),
  public.extraction_context(uuid),
  public.set_extraction_stage(uuid, text),
  public.complete_extraction(uuid, text, int, int, int, jsonb, jsonb, jsonb),
  public.fail_extraction(uuid, text, text, int, jsonb),
  public.get_extraction(uuid, timestamptz)
to authenticated;
