-- S14: F4 quick add (additive: two new functions; no table or column changes).
--
-- quick_add_auto_create  After the first extraction of a quick-add source succeeds, every pending
--                        High proposal becomes a thread at once (F4, D9, CLAUDE.md rule 2). Medium
--                        and Low stay pending for the review tray. Per item, as accept_proposals
--                        does: the thread, its verified evidence, one thread_events 'created' row
--                        and review_status = 'auto_created'. The event's actor is 'ai' and its
--                        `after` carries via = 'auto_create', mirroring transition(null, {type:
--                        "create", via: "auto_create"}, {actor: "ai"}) in lib/threads/transition.ts.
-- quick_add_undo         The 8 s undo of that auto-create (D8; server window 30 s
--                        from creation, user decision Nov 24; every other undo keeps D44's 12 s). F4: "Undo
--                        removes the thread and its events." The thread row and its events are
--                        deleted; its evidence goes back to the proposal, and the proposal is marked
--                        'rejected' without a suppression, so the same text typed again is proposed
--                        again. D44 states the auto-create undo is not its event-appending undo.
--
-- Both are SECURITY DEFINER, filter on auth.uid() themselves and check p_now against the database
-- clock (migration 20261021131140), like the other write-model functions (20261021115926).

create function public.quick_add_auto_create(p_extraction_id uuid, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  e record;
  r record;
  v_fields jsonb;
  v_thread uuid;
  v_event bigint;
  v_created jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);

  select x.id, x.status, x.source_id, x.created_at, s.kind into e
    from public.extractions x
    join public.sources s on s.id = x.source_id and s.user_id = x.user_id
    where x.id = p_extraction_id and x.user_id = v_uid and x.via_pipeline
    for update of x;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Only a quick add, only once it has succeeded, and only its first attempt: a `Try again` from
  -- the review page leaves every proposal to the review tray.
  if e.kind <> 'quick_add' or e.status <> 'succeeded' or exists (
    select 1 from public.extractions o
    where o.source_id = e.source_id and o.user_id = v_uid and o.via_pipeline and (o.created_at, o.id) < (e.created_at, e.id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  for r in
    select i.id, i.band, i.payload, i.confidence
    from public.extraction_items i
    where i.extraction_id = e.id and i.user_id = v_uid and i.review_status = 'pending' and i.thread_id is null
      and i.band = 'high'
    order by i.item_index, i.id
    for update
  loop
    v_fields := private.proposal_thread_fields(r.payload, e.source_id, r.confidence);
    -- Rule 1 and transition(): no verified evidence, no title, or waiting on nobody named → the
    -- item stays pending and goes to the review tray instead.
    if v_fields is null or not exists (
      select 1 from public.evidence ev where ev.extraction_item_id = r.id and ev.user_id = v_uid and ev.thread_id is null
    ) then
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
    values (v_uid, v_thread, 'ai', 'created', null,
            v_fields || jsonb_build_object('via', 'auto_create', 'extraction_item_id', r.id), p_now)
    returning id into v_event;

    update public.extraction_items i set review_status = 'auto_created', thread_id = v_thread, reviewed_at = p_now
      where i.id = r.id;

    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'item_id', r.id, 'thread_id', v_thread, 'event_id', v_event, 'band', r.band, 'title', v_fields ->> 'title'));
  end loop;

  return jsonb_build_object('ok', true, 'created', v_created);
end;
$$;

-- All-or-nothing over the threads one quick add created. Each must be the caller's, still hold
-- only its 'created' event from the auto-create (anything the user did since, such as Done or an
-- Edit, makes it a thread the user has acted on), and be within 30 s of that event. Otherwise
-- nothing is written and the answer is invalid_transition (SITE_CONTRACT §2.13 copy + Refresh).
create function public.quick_add_undo(p_thread_ids uuid[], p_event_ids bigint[], p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_n int := coalesce(cardinality(p_thread_ids), 0);
  i int;
  t public.threads;
  ev public.thread_events;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if v_n = 0 or v_n > 20 or v_n <> coalesce(cardinality(p_event_ids), 0)
     or (select count(distinct x) from unnest(p_thread_ids) x) <> v_n then
    raise exception 'invalid undo' using errcode = '22023';
  end if;
  -- Same answer as an expired window (thread_undo does the same).
  if not private.now_within_skew(p_now) then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  for i in 1 .. v_n loop
    select * into t from public.threads where id = p_thread_ids[i] and user_id = v_uid for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    select * into ev from public.thread_events x where x.thread_id = t.id and x.user_id = v_uid order by x.id desc limit 1;
    if ev.id is null or ev.id <> p_event_ids[i] or ev.type <> 'created' or ev.actor <> 'ai'
       or ev.after ->> 'via' is distinct from 'auto_create'
       or exists (select 1 from public.thread_events x where x.thread_id = t.id and x.user_id = v_uid and x.id <> ev.id)
       or p_now < ev.created_at or p_now > ev.created_at + interval '30 seconds' then
      return jsonb_build_object('ok', false, 'error', 'invalid_transition');
    end if;
  end loop;

  for i in 1 .. v_n loop
    -- The proposal keeps its verified evidence (it can be accepted from the tray later).
    update public.evidence e set thread_id = null
      where e.thread_id = p_thread_ids[i] and e.user_id = v_uid and e.extraction_item_id is not null;
    update public.extraction_items x set review_status = 'rejected', thread_id = null, reviewed_at = p_now
      where x.thread_id = p_thread_ids[i] and x.user_id = v_uid;
    -- Not a Forget: nothing is kept to suppress (migration 20261104090000's trigger reads this).
    delete from private.thread_suppression_hashes h where h.thread_id = p_thread_ids[i] and h.user_id = v_uid;
    -- Events and any remaining evidence go with the thread (ON DELETE CASCADE).
    delete from public.threads where id = p_thread_ids[i] and user_id = v_uid;
  end loop;

  return jsonb_build_object('ok', true, 'removed', v_n);
end;
$$;

revoke all on function
  public.quick_add_auto_create(uuid, timestamptz),
  public.quick_add_undo(uuid[], bigint[], timestamptz)
from public, anon;
grant execute on function
  public.quick_add_auto_create(uuid, timestamptz),
  public.quick_add_undo(uuid[], bigint[], timestamptz)
to authenticated;
