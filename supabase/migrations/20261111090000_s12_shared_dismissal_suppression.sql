-- S12 follow-up, lead-tester defect D1 (F9 "Dismissed threads never reappear"). Additive: one new
-- private function and new bodies for public.thread_reopen and private.thread_undo_unguarded
-- (signatures, owners and grants unchanged). Migration 20261110120000 is left as written.
--
-- Suppressions are unique per (user, hash), and a 'dismissed' row is linked to the first thread
-- dismissed with that hash. Two threads can carry one hash (the same item accepted twice). Reopen,
-- or Undo of a Dismiss, deleted the row outright, although another thread with the same hash was
-- still dismissed, so pasting the source again proposed the item again.
--
-- Now the row is handed over to another dismissed thread of the same user that carries the hash
-- (through its proposal or its kept hash, migration 20261104090000), and deleted only when there
-- is none. Rows with another reason (rejected, forgotten) are never touched, as before.

create function private.release_dismissal_suppressions(p_user uuid, p_thread uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.suppressions s
    set thread_id = o.other
  from (
    select s2.suppression_hash as h,
      (select x.tid from (
          select i.thread_id as tid from public.extraction_items i
            join public.threads t2 on t2.id = i.thread_id and t2.user_id = p_user
            where i.user_id = p_user and i.suppression_hash = s2.suppression_hash and t2.status = 'dismissed' and t2.id <> p_thread
          union
          select k.thread_id from private.thread_suppression_hashes k
            join public.threads t2 on t2.id = k.thread_id and t2.user_id = p_user
            where k.user_id = p_user and k.suppression_hash = s2.suppression_hash and t2.status = 'dismissed' and t2.id <> p_thread
        ) x order by x.tid limit 1) as other
    from public.suppressions s2
    where s2.user_id = p_user and s2.thread_id = p_thread and s2.reason = 'dismissed'
  ) o
  where s.user_id = p_user and s.suppression_hash = o.h and o.other is not null;

  delete from public.suppressions s where s.user_id = p_user and s.thread_id = p_thread and s.reason = 'dismissed';
end;
$$;
revoke all on function private.release_dismissal_suppressions(uuid, uuid) from public, anon, authenticated;

-- Same body as migration 20261110120000; the dismissal suppression is released, not deleted.
create or replace function public.thread_reopen(p_thread_id uuid, p_from_status text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
  v_event bigint;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status is distinct from p_from_status or t.status not in ('resolved', 'dismissed') then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  -- Keeps the decision row (PRD lifecycle table); the history shows the reopen.
  v_event := private.thread_commit(t,
    private.thread_state(t) || jsonb_build_object('status', 'open', 'resolution', null, 'resolved_at', null,
      'waiting_on', null, 'expected_by', null, 'snoozed_until', null),
    'reopened', p_now);
  if t.status = 'dismissed' then
    perform private.release_dismissal_suppressions(t.user_id, t.id);
  end if;
  return private.action_result(t, v_event, 'open');
end;
$$;

-- Same body as migration 20261110120000; undoing a Dismiss releases its suppression, as Reopen does.
create or replace function private.thread_undo_unguarded(p_thread_id uuid, p_event_id bigint, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.threads;
  e public.thread_events;
  v_state jsonb;
  v_next jsonb;
  r public.threads;
  d record;
  v_event bigint;
  v_keys constant text[] := array['title', 'kind', 'next_action', 'counterparty', 'due_at', 'due_certainty', 'due_time_known',
    'consequence', 'consequence_basis', 'status', 'resolution', 'waiting_on', 'expected_by', 'snoozed_until', 'resolved_at',
    'primary_source_id', 'confidence'];
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_now is null then raise exception 'p_now is required' using errcode = '22023'; end if;
  select * into t from public.threads where id = p_thread_id and user_id = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  select * into e from public.thread_events ev where ev.thread_id = t.id and ev.user_id = v_uid order by ev.id desc limit 1;
  -- Only the latest event, only the user's own reversible action, only within 8 s + 4 s grace of
  -- it (D44 a). The undoable event types mirror UNDOABLE_EVENT_TYPES in lib/threads/transition.ts.
  if e.id is null or e.id <> p_event_id or e.actor <> 'user' or e.type not in ('resolved', 'status_changed', 'snoozed', 'edited')
     or p_now < e.created_at or p_now > e.created_at + interval '12 seconds' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  v_state := private.thread_state(t);
  -- Only thread fields can be restored, and the thread must still hold the event's `after` values.
  if exists (select 1 from jsonb_object_keys(coalesce(e.before, '{}'::jsonb) || coalesce(e.after, '{}'::jsonb)) k where k <> all (v_keys))
     or not (v_state @> coalesce(e.after, '{}'::jsonb)) then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  v_next := v_state || coalesce(e.before, '{}'::jsonb);
  r := jsonb_populate_record(t, v_next);
  select * into d from private.state_diff(v_state, v_next);
  update public.threads set
    title = r.title, kind = r.kind, next_action = r.next_action, counterparty = r.counterparty, due_at = r.due_at,
    due_certainty = r.due_certainty, due_time_known = r.due_time_known, consequence = r.consequence,
    consequence_basis = r.consequence_basis, status = r.status, resolution = r.resolution, waiting_on = r.waiting_on,
    expected_by = r.expected_by, snoozed_until = r.snoozed_until, resolved_at = r.resolved_at,
    primary_source_id = r.primary_source_id, confidence = r.confidence, updated_at = p_now
  where id = t.id;
  -- A resolution as Decided wrote a decision; undoing it removes that decision (D44: the state
  -- before the action had none).
  delete from public.decisions where resolution_event_id = e.id and user_id = v_uid;
  -- A Dismiss wrote suppressions linked to the thread; undoing it removes them, as Reopen does.
  if e.type = 'status_changed' and e.after ->> 'status' = 'dismissed' then
    perform private.release_dismissal_suppressions(v_uid, t.id);
  end if;
  insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (v_uid, t.id, 'user', 'undone', d.before, d.after || jsonb_build_object('undone_event_id', e.id), p_now)
    returning id into v_event;

  return jsonb_build_object(
    'ok', true, 'thread_id', t.id, 'event_id', v_event, 'undone_event_id', e.id,
    'undone_action', case
      when e.type = 'resolved' then case when e.after ->> 'resolution' = 'done' then 'done' else 'resolve' end
      when e.type = 'snoozed' then 'snooze'
      when e.type = 'edited' then 'edit'
      when e.after ->> 'status' = 'waiting' then 'mark_waiting'
      when e.after ->> 'status' = 'dismissed' then 'dismiss'
      when e.before ->> 'status' = 'snoozed' then 'wake'
      else 'back_to_me' end,
    'from_status', t.status, 'to_status', r.status
  );
end;
$$;

revoke all on function private.thread_undo_unguarded(uuid, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.thread_reopen(uuid, text, timestamptz) from public, anon;
grant execute on function public.thread_reopen(uuid, text, timestamptz) to authenticated;
