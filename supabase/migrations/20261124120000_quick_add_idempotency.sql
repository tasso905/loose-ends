-- S14 follow-up, lead-tester defects D2 and D4 (F4 quick add). Additive: one private table and two
-- functions; migration 20261113120000 and start_source_extraction are left as written.
--
-- D2: when the response to a quick add is lost, the browser cannot know whether it was saved, and
-- `Try again` started a second source, a second daily count and a second thread. Each submission now
-- carries a key chosen by the browser. start_quick_add gives the same key the same extraction, with
-- no second source, count or pipeline attempt. Who runs the extraction is still decided by
-- set_extraction_stage (reading → finding succeeds once), so a replay never extracts again.
-- D4: quick_add_result says how long ago the threads were created, so the browser never has to
-- compare its clock with the server's.

-- Ids only. A key goes with its source (rule 8) and with the account.
create table private.quick_add_submissions (
  user_id uuid not null references public.profiles on delete cascade,
  key uuid not null,
  source_id uuid not null references public.sources (id) on delete cascade,
  extraction_id uuid not null references public.extractions (id) on delete cascade,
  primary key (user_id, key)
);
create index quick_add_submissions_source_idx on private.quick_add_submissions (source_id);
create index quick_add_submissions_extraction_idx on private.quick_add_submissions (extraction_id);
-- RLS on, no policy: only the SECURITY DEFINER function below reads or writes it.
alter table private.quick_add_submissions enable row level security;
revoke all on table private.quick_add_submissions from public, anon, authenticated;

-- p_allow_new = false only looks the key up (the app uses it while the AI budget is closed, so a
-- replay of a saved quick add is still answered): `{"error":"not_started"}` when it is unknown.
create function public.start_quick_add(
  p_key uuid, p_allow_new boolean, p_text text, p_reference_date date, p_now timestamptz,
  p_model text, p_prompt_version text, p_schema_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_source uuid;
  v_extraction uuid;
  v_text text;
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_key is null or p_allow_new is null then raise exception 'invalid submission' using errcode = '22023'; end if;
  if char_length(p_text) > 2000 then raise exception 'invalid text' using errcode = '22023'; end if;
  -- Two requests with one key run one after the other; the second finds the first's row.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_key::text, 0));

  select q.source_id, q.extraction_id, s.text_content into v_source, v_extraction, v_text
    from private.quick_add_submissions q join public.sources s on s.id = q.source_id and s.user_id = q.user_id
    where q.user_id = v_uid and q.key = p_key;
  if found then
    -- A key belongs to one text; another text under it would be silently dropped.
    if v_text is distinct from p_text then raise exception 'key used for another text' using errcode = '22023'; end if;
    return jsonb_build_object('source_id', v_source, 'extraction_id', v_extraction, 'replayed', true);
  end if;
  if not p_allow_new then return jsonb_build_object('error', 'not_started'); end if;

  v_out := public.start_source_extraction('quick_add', p_text, null, p_reference_date, p_now, p_model, p_prompt_version, p_schema_version);
  if v_out ? 'extraction_id' then
    insert into private.quick_add_submissions (user_id, key, source_id, extraction_id)
      values (v_uid, p_key, (v_out ->> 'source_id')::uuid, (v_out ->> 'extraction_id')::uuid);
    v_out := v_out || jsonb_build_object('replayed', false);
  end if;
  return v_out;
end;
$$;

-- Read-only (SECURITY INVOKER, RLS): the threads a quick add created that still exist, how long ago,
-- and whether nothing has happened to them since (quick_add_undo refuses otherwise).
create function public.quick_add_result(p_extraction_id uuid, p_now timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'created', coalesce(jsonb_agg(jsonb_build_object(
        'thread_id', t.id, 'event_id', ev.id, 'title', t.title) order by i.item_index, i.id), '[]'::jsonb),
    -- The oldest thread decides: one Undo covers all of them.
    'age_ms', coalesce(max(floor(extract(epoch from (p_now - ev.created_at)) * 1000)), 0)::bigint,
    'untouched', coalesce(bool_and(not exists (
        select 1 from public.thread_events x where x.thread_id = t.id and x.id <> ev.id)), false)
  )
  from public.extraction_items i
  join public.threads t on t.id = i.thread_id and t.user_id = i.user_id
  join public.thread_events ev on ev.thread_id = t.id and ev.type = 'created' and ev.actor = 'ai'
    and ev.after ->> 'via' = 'auto_create'
  where i.extraction_id = p_extraction_id and i.user_id = (select auth.uid()) and i.review_status = 'auto_created'
$$;

revoke all on function
  public.start_quick_add(uuid, boolean, text, date, timestamptz, text, text, text),
  public.quick_add_result(uuid, timestamptz)
from public, anon;
grant execute on function
  public.start_quick_add(uuid, boolean, text, date, timestamptz, text, text, text),
  public.quick_add_result(uuid, timestamptz)
to authenticated;
