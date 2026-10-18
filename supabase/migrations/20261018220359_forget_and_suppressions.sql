-- Forget permanently (F9, rule 8) and suppression (user decision B, Oct 18).
--
-- Forget hard-deletes the thread, its events, evidence and decision, AND its originating
-- extraction_items rows (payload, title, quote), and blanks that item in extractions.raw_output.
-- Only the suppression hash survives, in its own table, so re-extracting the same source does not
-- re-propose the item. Suppression never depends on an extraction_items row.

-- Position of the item in extractions.raw_output->'items', so Forget can blank the model's copy.
-- NOT NULL: persistence always writes it from Proposal.index; Forget fails closed without it.
alter table public.extraction_items add column item_index int not null check (item_index >= 0);

-- Evidence must always belong to something the user can reach and delete (rule 8). Thread evidence
-- survives source deletion (thread_id set); proposal evidence goes with its proposal (trigger below).
alter table public.evidence add constraint evidence_has_reference
  check (source_id is not null or thread_id is not null or extraction_item_id is not null);

-- When a proposal is deleted (directly, by cascade from its source or extraction, or by Forget),
-- delete its evidence that is not also a thread's. BEFORE DELETE so it runs while the link exists.
create function public.extraction_items_delete_evidence() returns trigger
language plpgsql as $$
begin
  delete from public.evidence ev where ev.extraction_item_id = old.id and ev.thread_id is null;
  return old;
end;
$$;
-- Evidence that references only its source goes with the source (otherwise source_id would be set
-- null, leaving an orphan that evidence_has_reference rejects, and the source could not be deleted).
create function public.sources_delete_source_only_evidence() returns trigger
language plpgsql as $$
begin
  delete from public.evidence ev
    where ev.source_id = old.id and ev.thread_id is null and ev.extraction_item_id is null;
  return old;
end;
$$;
create trigger sources_delete_source_only_evidence
  before delete on public.sources
  for each row execute function public.sources_delete_source_only_evidence();

create trigger extraction_items_delete_evidence
  before delete on public.extraction_items
  for each row execute function public.extraction_items_delete_evidence();

create table public.suppressions (
  user_id uuid not null references public.profiles on delete cascade,
  suppression_hash text not null,                 -- hash(source text hash + quote); no content
  reason text not null check (reason in ('dismissed','rejected','forgotten')),
  thread_id uuid,                                 -- set for dismissals so Reopen can remove them
  created_at timestamptz not null default now(),
  primary key (user_id, suppression_hash),
  constraint suppressions_thread_fk
    foreign key (thread_id, user_id) references public.threads (id, user_id) on delete set null (thread_id)
);
create index suppressions_thread_idx on public.suppressions (thread_id);

alter table public.suppressions enable row level security;
create policy suppressions_own on public.suppressions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Runs as the caller (security invoker), so RLS limits it to the caller's own rows.
-- Returns deletion counts and the source's storage_path, if the source was deleted, so the server
-- action can remove the storage object through the Storage API in the same request.
-- Quote normalization for brief scrubbing: typographic quotes/dashes folded, whitespace collapsed,
-- case folded (same idea as lib/pipeline/normalize.ts).
create function public.norm_quote(t text) returns text
language sql immutable as $$
  select lower(btrim(regexp_replace(
    translate(coalesce(t, ''),
      chr(8216) || chr(8217) || chr(8218) || chr(8219) || chr(8220) || chr(8221) || chr(8222) || chr(8223) || chr(8211) || chr(8212) || chr(160),
      '''''''''' || '""""' || '-- '),
    '\s+', ' ', 'g')))
$$;

-- Explain card scrub (user decision, Oct 18): drop every brief line whose quote or text overlaps a
-- forgotten quote (either contains the other, after normalization). Over-removal is accepted;
-- everything else in the brief is kept as is.
create function public.scrub_brief(p_brief jsonb, p_quotes text[]) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb := '{}'::jsonb;
  v_kept jsonb;
  v_el jsonb;
  v_hit boolean;
  q text;
  a text;
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
      foreach q in array p_quotes loop
        q := public.norm_quote(q);
        continue when q = '';
        foreach a in array array[
          case when jsonb_typeof(v_el) = 'string' then v_el #>> '{}' else v_el ->> 'quote' end,
          case when jsonb_typeof(v_el) = 'object' then v_el ->> 'text' end
        ] loop
          a := public.norm_quote(a);
          if a <> '' and (position(q in a) > 0 or position(a in q) > 0) then
            v_hit := true;
          end if;
        end loop;
      end loop;
      if not v_hit then
        v_kept := v_kept || jsonb_build_array(v_el);
      end if;
    end loop;
    v_out := v_out || jsonb_build_object(v_key, v_kept);
  end loop;
  return v_out;
end;
$$;

create function public.forget_thread(p_thread_id uuid, p_delete_source boolean default false)
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
      set brief = public.scrub_brief(e.brief, v_quotes),
          raw_output = case when jsonb_typeof(e.raw_output) = 'object' and e.raw_output ? 'brief'
                                 and jsonb_typeof(e.raw_output -> 'brief') = 'object'
                            then jsonb_set(e.raw_output, '{brief}', public.scrub_brief(e.raw_output -> 'brief', v_quotes))
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
