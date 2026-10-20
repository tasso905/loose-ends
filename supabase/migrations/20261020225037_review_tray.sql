-- S3: F6 Review Tray accept and reject (additive only: new functions, no table changes).
--
-- accept_proposals        proposal → thread, one transaction for the whole call. Per item: the
--                         thread, its evidence (the proposal's verified evidence rows gain
--                         thread_id and keep extraction_item_id), a thread_events 'created' row
--                         (actor user) and review_status = accepted. Repeat calls write nothing.
-- reject_proposals        review_status = rejected + a 'rejected' suppression with the same hash
--                         complete_extraction() filters on, so the item is not proposed again.
-- undo_reject_proposals   the inline "Rejected · Undo": back to pending, suppression removed.
--
-- The thread's initial fields come from private.proposal_thread_fields(), which mirrors
-- transition(null, {type: "create", via: "accept"}) in lib/threads/transition.ts and the D5
-- mapping in lib/threads/mapping.ts. SQL cannot call the TypeScript, so
-- tests/integration/review-tray.test.ts proves the two agree (thread row and event `after`).
--
-- All three are SECURITY INVOKER (RLS applies) and also filter on auth.uid() themselves, so an id
-- that is not the caller's refuses the whole call with nothing written, even without RLS.

-- Mirror of transition(create, via accept) for a stored ProposalPayloadV1 (A11). Returns the
-- created ThreadState as jsonb (all 17 keys, same names and values as the TypeScript), or null when
-- transition() would return invalid_transition (no title; waiting with nobody named) or the item
-- never becomes a thread (key_fact, D5). Instants stay the payload's own ISO strings.
create function private.proposal_thread_fields(p_payload jsonb, p_source uuid, p_confidence numeric)
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_item jsonb := p_payload -> 'item';
  v_date jsonb := p_payload -> 'date';
  v_type text := v_item ->> 'type';
  v_owner text := v_item ->> 'owner';
  v_kind text;
  v_status text;
  v_title text := v_item ->> 'title';
  v_counterparty text := v_item ->> 'counterparty';
  v_due_at text := v_date ->> 'due_at';
begin
  if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_date) <> 'object' then return null; end if;
  -- D5 mapping (lib/threads/mapping.ts threadKindFor).
  v_kind := case v_type
    when 'commitment' then case when v_owner = 'other' then 'waiting_on' else 'commitment' end
    when 'request' then 'request'
    when 'waiting_on' then 'waiting_on'
    when 'deadline' then 'admin'
    when 'intention' then 'commitment'
    when 'decision' then 'decision'
    else null
  end;
  if v_kind is null then return null; end if;
  v_status := case when v_kind = 'waiting_on' then 'waiting' else 'open' end;

  -- transition(): nonEmpty(title); waiting requires nonEmpty(waiting_on).
  if v_title is null or v_title !~ '[^[:space:]]' then return null; end if;
  if v_status = 'waiting' and (v_counterparty is null or v_counterparty !~ '[^[:space:]]') then return null; end if;

  return jsonb_build_object(
    'title', v_title,
    'kind', v_kind,
    'next_action', v_item -> 'action',
    'counterparty', v_item -> 'counterparty',
    'due_at', to_jsonb(v_due_at),
    'due_certainty', case when v_due_at is not null then v_date -> 'due_certainty' else '"none"'::jsonb end,
    'due_time_known', case when v_due_at is not null then coalesce(v_date -> 'due_time_known', 'false'::jsonb) else 'false'::jsonb end,
    -- The extraction schema has no consequence field; a proposal never carries one.
    'consequence', null,
    'consequence_basis', null,
    'status', v_status,
    'resolution', null,
    -- PRD mapping table: waiting_on = counterparty, expected_by = the resolved date if any.
    'waiting_on', case when v_status = 'waiting' then to_jsonb(v_counterparty) else 'null'::jsonb end,
    'expected_by', case when v_status = 'waiting' then to_jsonb(v_due_at) else 'null'::jsonb end,
    'snoozed_until', null,
    'resolved_at', null,
    'primary_source_id', to_jsonb(p_source),
    'confidence', to_jsonb(p_confidence)
  );
end;
$$;

-- Locks the caller's items and returns how many of p_ids are the caller's and in the extraction.
create function private.lock_own_items(p_extraction_id uuid, p_ids uuid[]) returns int
language sql set search_path = '' as $$
  select count(*)::int from (
    select i.id from public.extraction_items i
    where i.id = any (p_ids) and i.extraction_id = p_extraction_id and i.user_id = (select auth.uid())
    order by i.id
    for update
  ) locked
$$;

create function public.accept_proposals(p_extraction_id uuid, p_item_ids uuid[], p_now timestamptz)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  r record;
  v_fields jsonb;
  v_thread uuid;
  v_created jsonb := '[]'::jsonb;
  v_already jsonb := '[]'::jsonb;
  v_invalid jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_item_ids, '{}')) x where x is not null;
  if cardinality(v_ids) > 100 then raise exception 'too many items' using errcode = '22023'; end if;
  -- Any id that is not the caller's (or not in this extraction) refuses the whole call.
  if private.lock_own_items(p_extraction_id, v_ids) <> cardinality(v_ids) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  for r in
    select i.id, i.band, i.review_status, i.thread_id, i.payload, i.confidence, e.source_id, e.status as extraction_status
    from public.extraction_items i
    join public.extractions e on e.id = i.extraction_id and e.user_id = i.user_id
    where i.id = any (v_ids) and i.user_id = v_uid
    order by i.item_index, i.id
  loop
    -- Idempotent: an item that already has its thread writes nothing.
    if r.thread_id is not null or r.review_status in ('accepted', 'edited', 'auto_created') then
      v_already := v_already || jsonb_build_array(jsonb_build_object('item_id', r.id, 'thread_id', r.thread_id, 'band', r.band));
      continue;
    end if;
    -- Rejected must be undone first; Ignore is never shown (D3).
    if r.review_status <> 'pending' or r.band = 'ignore' or r.extraction_status <> 'succeeded' then
      v_invalid := v_invalid || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
      continue;
    end if;
    v_fields := private.proposal_thread_fields(r.payload, r.source_id, r.confidence);
    -- Rule 1: no verified quote, no item. The proposal's verified evidence rows become the thread's.
    if v_fields is null or not exists (
      select 1 from public.evidence ev where ev.extraction_item_id = r.id and ev.user_id = v_uid and ev.thread_id is null
    ) then
      v_invalid := v_invalid || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
      continue;
    end if;

    insert into public.threads (
      user_id, title, kind, next_action, counterparty, due_at, due_certainty, due_time_known,
      consequence, consequence_basis, status, resolution, waiting_on, expected_by, snoozed_until,
      primary_source_id, confidence, created_at, updated_at, resolved_at
    ) values (
      v_uid, v_fields ->> 'title', v_fields ->> 'kind', v_fields ->> 'next_action', v_fields ->> 'counterparty',
      (v_fields ->> 'due_at')::timestamptz, v_fields ->> 'due_certainty', (v_fields ->> 'due_time_known')::boolean,
      null, null, v_fields ->> 'status', null, v_fields ->> 'waiting_on', (v_fields ->> 'expected_by')::timestamptz, null,
      (v_fields ->> 'primary_source_id')::uuid, (v_fields ->> 'confidence')::numeric, p_now, p_now, null
    ) returning id into v_thread;

    update public.evidence ev set thread_id = v_thread
      where ev.extraction_item_id = r.id and ev.user_id = v_uid and ev.thread_id is null;

    insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (v_uid, v_thread, 'user', 'created', null,
            v_fields || jsonb_build_object('via', 'accept', 'extraction_item_id', r.id), p_now);

    update public.extraction_items i set review_status = 'accepted', thread_id = v_thread, reviewed_at = p_now
      where i.id = r.id;

    v_created := v_created || jsonb_build_array(jsonb_build_object('item_id', r.id, 'thread_id', v_thread, 'band', r.band));
  end loop;

  return jsonb_build_object('ok', true, 'created', v_created, 'already', v_already, 'invalid', v_invalid);
end;
$$;

create function public.reject_proposals(p_extraction_id uuid, p_item_ids uuid[], p_now timestamptz)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  r record;
  v_rejected jsonb := '[]'::jsonb;
  v_already jsonb := '[]'::jsonb;
  v_invalid jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_item_ids, '{}')) x where x is not null;
  if cardinality(v_ids) > 100 then raise exception 'too many items' using errcode = '22023'; end if;
  if private.lock_own_items(p_extraction_id, v_ids) <> cardinality(v_ids) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  for r in
    select i.id, i.band, i.review_status, i.suppression_hash from public.extraction_items i
    where i.id = any (v_ids) and i.user_id = v_uid
    order by i.item_index, i.id
  loop
    if r.review_status = 'rejected' then
      v_already := v_already || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
      continue;
    end if;
    -- An accepted item is a thread now; closing it is Dismiss on the thread, not a reject.
    if r.review_status <> 'pending' or r.band = 'ignore' then
      v_invalid := v_invalid || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
      continue;
    end if;
    update public.extraction_items i set review_status = 'rejected', reviewed_at = p_now where i.id = r.id;
    if r.suppression_hash is not null then
      -- A stronger existing record (dismissed, forgotten) is kept as it is.
      insert into public.suppressions (user_id, suppression_hash, reason, thread_id, created_at)
      values (v_uid, r.suppression_hash, 'rejected', null, p_now)
      on conflict (user_id, suppression_hash) do nothing;
    end if;
    v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
  end loop;

  return jsonb_build_object('ok', true, 'rejected', v_rejected, 'already', v_already, 'invalid', v_invalid);
end;
$$;

create function public.undo_reject_proposals(p_extraction_id uuid, p_item_ids uuid[])
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  r record;
  v_restored jsonb := '[]'::jsonb;
  v_invalid jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_item_ids, '{}')) x where x is not null;
  if cardinality(v_ids) > 100 then raise exception 'too many items' using errcode = '22023'; end if;
  if private.lock_own_items(p_extraction_id, v_ids) <> cardinality(v_ids) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  for r in
    select i.id, i.band, i.review_status, i.suppression_hash from public.extraction_items i
    where i.id = any (v_ids) and i.user_id = v_uid
    order by i.item_index, i.id
  loop
    if r.review_status = 'pending' then
      v_restored := v_restored || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
      continue;
    end if;
    if r.review_status <> 'rejected' then
      v_invalid := v_invalid || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
      continue;
    end if;
    update public.extraction_items i set review_status = 'pending', reviewed_at = null where i.id = r.id;
    -- Only the rejection this reject wrote goes; another rejected copy of the same item keeps it.
    delete from public.suppressions s
      where s.user_id = v_uid and s.suppression_hash = r.suppression_hash and s.reason = 'rejected'
        and not exists (
          select 1 from public.extraction_items o
          where o.user_id = v_uid and o.suppression_hash = r.suppression_hash and o.review_status = 'rejected' and o.id <> r.id
        );
    v_restored := v_restored || jsonb_build_array(jsonb_build_object('item_id', r.id, 'band', r.band));
  end loop;

  return jsonb_build_object('ok', true, 'restored', v_restored, 'invalid', v_invalid);
end;
$$;

revoke all on function
  private.proposal_thread_fields(jsonb, uuid, numeric),
  private.lock_own_items(uuid, uuid[])
from public, anon;
grant execute on function
  private.proposal_thread_fields(jsonb, uuid, numeric),
  private.lock_own_items(uuid, uuid[])
to authenticated;

revoke all on function
  public.accept_proposals(uuid, uuid[], timestamptz),
  public.reject_proposals(uuid, uuid[], timestamptz),
  public.undo_reject_proposals(uuid, uuid[])
from public, anon;
grant execute on function
  public.accept_proposals(uuid, uuid[], timestamptz),
  public.reject_proposals(uuid, uuid[], timestamptz),
  public.undo_reject_proposals(uuid, uuid[])
to authenticated;
