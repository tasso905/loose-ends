-- S2: F2 paste → F5 extraction → progress (additive only).
--
-- A1: extractions.stage records the real pipeline step the server is on, so the progress page
--     shows only steps that happened (SITE_CONTRACT §2.3; no fake progress).
-- The extraction lifecycle runs through the functions below so each step is one atomic statement:
--   start_source_extraction  consume_usage + sources + extractions(running), or nothing (A3).
--   retry_extraction         a new running attempt for a failed one; not counted again (A3).
--   extraction_context       what extract() needs: source text, reference date, who is "me".
--   set_extraction_stage     A1 stage updates while running.
--   complete_extraction      extraction_items (+ proposal evidence) and status succeeded, all or
--                            nothing; suppressed hashes are skipped and blanked from raw_output.
--   fail_extraction          status failed with a content-free error code; no items.
--   get_extraction           poll read; marks a running row older than 90 s failed (A2).
-- All are SECURITY INVOKER: RLS (user_id = auth.uid()) applies to every row they touch.

alter table public.extractions add column stage text
  check (stage in ('reading', 'finding', 'checking'));

create index extractions_user_created_idx on public.extractions (user_id, created_at desc);

create function public.start_source_extraction(
  p_kind text,
  p_text text,
  p_title text,
  p_reference_date date,
  p_now timestamptz,
  p_model text,
  p_prompt_version text,
  p_schema_version text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_ref date := p_reference_date;
  v_ref_source text := 'user';
  v_source uuid;
  v_extraction uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_kind not in ('paste', 'quick_add') then raise exception 'unsupported kind %', p_kind; end if;
  if p_text is null or btrim(p_text) = '' or char_length(p_text) > 30000 then
    raise exception 'invalid text' using errcode = '22023';
  end if;
  if p_title is not null and char_length(p_title) > 120 then
    raise exception 'invalid title' using errcode = '22023';
  end if;

  if v_ref is null then
    select p.timezone into v_tz from public.profiles p where p.id = v_uid;
    if not found then raise exception 'no profile'; end if;
    v_ref := (p_now at time zone v_tz)::date;
    v_ref_source := 'defaulted';
  end if;

  -- One count per source submission. If an insert below fails, the count rolls back with it.
  if not public.consume_usage('extraction') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  insert into public.sources (user_id, kind, title, text_content, reference_date, reference_date_source)
  values (v_uid, p_kind, nullif(btrim(p_title), ''), p_text, v_ref, v_ref_source)
  returning id into v_source;

  insert into public.extractions (user_id, source_id, status, stage, model, prompt_version, schema_version)
  values (v_uid, v_source, 'running', 'reading', p_model, p_prompt_version, p_schema_version)
  returning id into v_extraction;

  return jsonb_build_object('source_id', v_source, 'extraction_id', v_extraction);
end;
$$;

-- "Try again" after extraction_failed: a new attempt on the same source, not counted again (A3).
-- Only the newest attempt for a source can be retried, and the source row is locked, so a double
-- click returns the attempt already started instead of starting two.
create function public.retry_extraction(
  p_extraction_id uuid,
  p_model text,
  p_prompt_version text,
  p_schema_version text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_source uuid;
  v_status text;
  v_latest uuid;
  v_latest_status text;
  v_new uuid;
begin
  select e.source_id into v_source from public.extractions e where e.id = p_extraction_id and e.user_id = v_uid;
  if not found then return null; end if;

  perform 1 from public.sources s where s.id = v_source and s.user_id = v_uid and s.text_content is not null for update;
  if not found then return jsonb_build_object('error', 'source_unavailable'); end if;

  select e.id, e.status into v_latest, v_latest_status from public.extractions e
    where e.source_id = v_source and e.user_id = v_uid
    order by e.created_at desc, e.id desc limit 1;
  if v_latest <> p_extraction_id then
    return jsonb_build_object('extraction_id', v_latest);
  end if;
  select e.status into v_status from public.extractions e where e.id = p_extraction_id;
  if v_status <> 'failed' then
    return jsonb_build_object('error', 'not_failed', 'status', v_status);
  end if;

  insert into public.extractions (user_id, source_id, status, stage, model, prompt_version, schema_version)
  values (v_uid, v_source, 'running', 'reading', p_model, p_prompt_version, p_schema_version)
  returning id into v_new;
  return jsonb_build_object('extraction_id', v_new);
end;
$$;

create function public.extraction_context(p_extraction_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'status', e.status,
    'source_kind', s.kind,
    'source_text', s.text_content,
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
  where e.id = p_extraction_id and e.user_id = (select auth.uid())
$$;

create function public.set_extraction_stage(p_extraction_id uuid, p_stage text) returns boolean
language sql security invoker set search_path = '' as $$
  with u as (
    update public.extractions e set stage = p_stage
    where e.id = p_extraction_id and e.user_id = (select auth.uid()) and e.status = 'running'
    returning 1
  )
  select exists (select 1 from u)
$$;

-- p_items: [{item_index, payload, confidence, band, suppression_hash,
--            evidence: [{quote, start_offset, end_offset, page, match_kind, quote_hash}]}]
create function public.complete_extraction(
  p_extraction_id uuid,
  p_model text,
  p_input_tokens int,
  p_output_tokens int,
  p_latency_ms int,
  p_raw_output jsonb,
  p_brief jsonb,
  p_items jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
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
  select e.source_id, e.status into v_source, v_status from public.extractions e
    where e.id = p_extraction_id and e.user_id = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  -- A timed-out (A2) or already finished attempt is never written to.
  if v_status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'not_running'); end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_idx := (v_item ->> 'item_index')::int;
    select s.reason into v_reason from public.suppressions s
      where s.user_id = v_uid and s.suppression_hash = v_item ->> 'suppression_hash';
    if found then
      -- Never re-proposed; the model's copy of the item is blanked as Forget does.
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

  -- A forgotten item stays forgotten in the new Explain card too (D35).
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

create function public.fail_extraction(
  p_extraction_id uuid,
  p_error text,
  p_model text,
  p_latency_ms int,
  p_raw_output jsonb
) returns boolean
language sql security invoker set search_path = '' as $$
  with u as (
    update public.extractions e set
      status = 'failed', stage = null, error = p_error,
      model = coalesce(p_model, e.model), latency_ms = p_latency_ms, raw_output = p_raw_output
    where e.id = p_extraction_id and e.user_id = (select auth.uid()) and e.status = 'running'
    returning 1
  )
  select exists (select 1 from u)
$$;

-- Poll read (GET /api/extractions/:id and /review/[id]). p_now comes from getNow() so tests can
-- move the clock. Ignore-band items are stored but never returned (D3).
create function public.get_extraction(p_extraction_id uuid, p_now timestamptz) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  update public.extractions e set status = 'failed', stage = null, error = 'timeout'
    where e.id = p_extraction_id and e.user_id = v_uid and e.status = 'running'
      and e.created_at < p_now - interval '90 seconds';

  select jsonb_build_object(
    'id', e.id,
    'source_id', e.source_id,
    'status', e.status,
    'stage', e.stage,
    'error', e.error,
    'created_at', e.created_at,
    'brief', e.brief,
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
  where e.id = p_extraction_id and e.user_id = v_uid;
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
