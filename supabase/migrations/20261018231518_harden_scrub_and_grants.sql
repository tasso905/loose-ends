-- Pre-release hardening (additive; earlier migrations are merged and immutable).
--
-- 1. scrub_brief precision (D35): match only on a brief line's quote (never its text), by source
--    offset overlap when the line has offsets, else by text: exact equality, or containment only when
--    the shorter side has at least 12 normalized characters and 3 words.
-- 2. Internal helpers move to a schema PostgREST does not expose (`private`); the public copies and
--    all trigger functions lose EXECUTE for public, anon and authenticated, so /rpc cannot call them.
--    forget_thread and consume_usage stay callable by authenticated only.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create function private.norm_quote(t text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(
    translate(coalesce(t, ''),
      chr(8216) || chr(8217) || chr(8218) || chr(8219) || chr(8220) || chr(8221) || chr(8222) || chr(8223) || chr(8211) || chr(8212) || chr(160),
      '''''''''' || '""""' || '-- '),
    '\s+', ' ', 'g')))
$$;

-- True when two quotes are the same passage: equal after normalization, or one contains the other
-- and the shorter is long enough (>= 12 characters and >= 3 words) not to match by accident.
create function private.quotes_match(a text, b text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  na text := private.norm_quote(a);
  nb text := private.norm_quote(b);
  shorter text;
begin
  if na = '' or nb = '' then return false; end if;
  if na = nb then return true; end if;
  shorter := case when length(na) <= length(nb) then na else nb end;
  if length(shorter) < 12 or array_length(regexp_split_to_array(shorter, ' '), 1) < 3 then return false; end if;
  return position(na in nb) > 0 or position(nb in na) > 0;
end;
$$;

-- Drops brief lines that quote a forgotten passage. Object lines are judged by their `quote` (and by
-- `match.start_offset/end_offset` against p_ranges when both exist); plain-string lines
-- (not_sure_about) by their own text with the same text rule. Everything else is kept as is.
create function private.scrub_brief(p_brief jsonb, p_quotes text[], p_ranges int4range[] default '{}')
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb := '{}'::jsonb;
  v_kept jsonb;
  v_el jsonb;
  v_hit boolean;
  v_line text;
  v_range int4range;
  q text;
begin
  if p_brief is null or jsonb_typeof(p_brief) <> 'object' then
    return p_brief;
  end if;
  for v_key, v_val in select * from jsonb_each(p_brief) loop
    if jsonb_typeof(v_val) <> 'array' then
      v_out := v_out || jsonb_build_object(v_key, v_val);
      continue;
    end if;
    v_kept := '[]'::jsonb;
    for v_el in select * from jsonb_array_elements(v_val) loop
      v_hit := false;
      v_range := null;
      if jsonb_typeof(v_el) = 'object'
         and jsonb_typeof(v_el #> '{match,start_offset}') = 'number'
         and jsonb_typeof(v_el #> '{match,end_offset}') = 'number'
         and (v_el #>> '{match,end_offset}')::numeric > (v_el #>> '{match,start_offset}')::numeric then
        v_range := int4range((v_el #>> '{match,start_offset}')::int, (v_el #>> '{match,end_offset}')::int);
      end if;
      if v_range is not null and coalesce(cardinality(p_ranges), 0) > 0 then
        v_hit := v_range && any (p_ranges);
      else
        v_line := case jsonb_typeof(v_el) when 'string' then v_el #>> '{}' when 'object' then v_el ->> 'quote' end;
        if v_line is not null then
          foreach q in array coalesce(p_quotes, '{}') loop
            if private.quotes_match(q, v_line) then v_hit := true; exit; end if;
          end loop;
        end if;
      end if;
      if not v_hit then
        v_kept := v_kept || jsonb_build_array(v_el);
      end if;
    end loop;
    v_out := v_out || jsonb_build_object(v_key, v_kept);
  end loop;
  return v_out;
end;
$$;

revoke all on function private.norm_quote(text), private.quotes_match(text, text),
  private.scrub_brief(jsonb, text[], int4range[]) from public, anon;
grant execute on function private.norm_quote(text), private.quotes_match(text, text),
  private.scrub_brief(jsonb, text[], int4range[]) to authenticated;

-- Public copies now delegate (kept so nothing that references them breaks) and are not callable by
-- any API role.
create or replace function public.norm_quote(t text) returns text
language sql immutable set search_path = '' as $$ select private.norm_quote(t) $$;

create or replace function public.scrub_brief(p_brief jsonb, p_quotes text[]) returns jsonb
language sql immutable set search_path = '' as $$ select private.scrub_brief(p_brief, p_quotes, '{}') $$;

revoke all on function public.norm_quote(text), public.scrub_brief(jsonb, text[]) from public, anon, authenticated;

-- Trigger functions are never called directly (triggers do not need EXECUTE at fire time).
revoke all on function
  public.thread_events_no_update(),
  public.touch_updated_at(),
  public.handle_new_user(),
  public.profiles_check_timezone(),
  public.extraction_items_delete_evidence(),
  public.sources_delete_source_only_evidence()
from public, anon, authenticated;

-- forget_thread: same steps as before; the brief scrub now uses private.scrub_brief with the
-- forgotten evidence's source offsets.
create or replace function public.forget_thread(p_thread_id uuid, p_delete_source boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_source uuid;
  v_storage text;
  v_items int;
  v_evidence int;
  v_sources int := 0;
  v_raw jsonb;
  v_quotes text[];
  r record;
begin
  select t.primary_source_id into v_source from public.threads t where t.id = p_thread_id and t.user_id = v_uid;
  if not found then
    raise exception 'thread not found' using errcode = 'P0002';
  end if;

  -- 1. Keep only the hashes.
  insert into public.suppressions (user_id, suppression_hash, reason, thread_id)
  select v_uid, ei.suppression_hash, 'forgotten', null
  from public.extraction_items ei
  where ei.thread_id = p_thread_id and ei.suppression_hash is not null
  on conflict (user_id, suppression_hash) do update set reason = 'forgotten', thread_id = null;

  -- 1b. Remove Explain-card lines quoting the forgotten item, from both copies of the brief.
  select coalesce(array_agg(distinct x.q), '{}') into v_quotes from (
    select ev.quote as q from public.evidence ev
      where ev.thread_id = p_thread_id
         or ev.extraction_item_id in (select ei.id from public.extraction_items ei where ei.thread_id = p_thread_id)
    union all
    select el ->> 'quote' from public.extraction_items ei,
      lateral jsonb_array_elements(case when jsonb_typeof(ei.payload -> 'evidence') = 'array' then ei.payload -> 'evidence' else '[]'::jsonb end) el
      where ei.thread_id = p_thread_id
  ) x where x.q is not null;
  if coalesce(array_length(v_quotes, 1), 0) > 0 then
    update public.extractions e
      set brief = private.scrub_brief(e.brief, v_quotes, coalesce((
            select array_agg(int4range(ev.start_offset, ev.end_offset)) from public.evidence ev
            where ev.source_id = e.source_id and ev.start_offset is not null and ev.end_offset > ev.start_offset
              and (ev.thread_id = p_thread_id
                   or ev.extraction_item_id in (select ei.id from public.extraction_items ei where ei.thread_id = p_thread_id))
          ), '{}')),
          -- The model's copy has no verified offsets: text rule only.
          raw_output = case when jsonb_typeof(e.raw_output) = 'object' and e.raw_output ? 'brief'
                                 and jsonb_typeof(e.raw_output -> 'brief') = 'object'
                            then jsonb_set(e.raw_output, '{brief}', private.scrub_brief(e.raw_output -> 'brief', v_quotes, '{}'))
                            else e.raw_output end
      where e.id in (select ei.extraction_id from public.extraction_items ei where ei.thread_id = p_thread_id);
  end if;

  -- 2. Blank the model's raw copy of each originating item (indices of other items are kept).
  --    Fails closed without blocking: if the stored raw output is malformed (not an object with an
  --    items array, or no entry at that index), the whole raw output is discarded and Forget goes on.
  for r in
    select ei.extraction_id, ei.item_index from public.extraction_items ei where ei.thread_id = p_thread_id
  loop
    select e.raw_output into v_raw from public.extractions e where e.id = r.extraction_id;
    if v_raw is not null then
      if jsonb_typeof(v_raw) = 'object'
         and coalesce(jsonb_typeof(v_raw -> 'items'), '') = 'array'
         and r.item_index < jsonb_array_length(v_raw -> 'items') then
        update public.extractions e
          set raw_output = jsonb_set(e.raw_output, array['items', r.item_index::text], 'null'::jsonb, false)
          where e.id = r.extraction_id;
      else
        update public.extractions e set raw_output = null where e.id = r.extraction_id;
      end if;
    end if;
  end loop;

  -- 3. Delete all evidence of the thread and of its originating proposals, then the proposals.
  delete from public.evidence ev
    where ev.thread_id = p_thread_id
       or ev.extraction_item_id in (select ei.id from public.extraction_items ei where ei.thread_id = p_thread_id);
  get diagnostics v_evidence = row_count;
  delete from public.extraction_items ei where ei.thread_id = p_thread_id;
  get diagnostics v_items = row_count;

  -- 4. Optionally the source ("also delete source"); cascades to its extractions and proposals.
  if p_delete_source and v_source is not null then
    select s.storage_path into v_storage from public.sources s where s.id = v_source;
    delete from public.sources s where s.id = v_source;
    get diagnostics v_sources = row_count;
  end if;

  -- 5. The thread; thread_events and decisions cascade.
  delete from public.threads t where t.id = p_thread_id;

  return jsonb_build_object(
    'threads', 1, 'extraction_items', v_items, 'evidence', v_evidence,
    'sources', v_sources, 'storage_path', v_storage
  );
end;
$$;
revoke all on function public.forget_thread(uuid, boolean) from public, anon;
grant execute on function public.forget_thread(uuid, boolean) to authenticated;
