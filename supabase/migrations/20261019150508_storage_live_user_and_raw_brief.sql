-- Pre-release review fixes (additive).
--
-- B1 (rule 8): a deleted user's still-valid JWT could upload into {uid}/ after account deletion,
--    because the storage insert policy only compared the folder with auth.uid(). Inserts now also
--    require the user's profile row to exist (it is gone once the auth user is deleted).
--    The sources bucket has no update policy, so updates and upserts are already refused.
alter policy sources_bucket_insert_own on storage.objects
  with check (
    bucket_id = 'sources'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()))
  );

-- B2 (rule 8): Forget sets raw_output.brief to null (the model's raw copy has no offsets, so it
--    cannot be scrubbed precisely, and it is never shown). extractions.brief keeps the offset/text scrub.
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
          -- The model's copy has no verified offsets and is never shown: drop its brief entirely.
          raw_output = case when jsonb_typeof(e.raw_output) = 'object' and e.raw_output ? 'brief'
                            then jsonb_set(e.raw_output, '{brief}', 'null'::jsonb)
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
