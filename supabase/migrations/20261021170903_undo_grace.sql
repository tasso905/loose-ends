-- D44 (a), approved by the user Oct 21: Undo restores the exact `before` state, appends an `undone`
-- event and has an 8 s window, plus a 4 s server grace period, so the database accepts an Undo up
-- to 12 s after the action. The toast still shows for 8 s and pauses while hovered or focused; the
-- grace covers a short pause and the round trip, so an Undo the toast offers within that is not
-- refused. Mirrors UNDO_WINDOW_MS + UNDO_GRACE_MS in lib/threads/transition.ts.
--
-- Additive: replaces the body of private.thread_undo_unguarded (moved there by migration
-- 20261021131140); only the interval changes. public.thread_undo, its clock guard and the grants are
-- unchanged (CREATE OR REPLACE keeps the owner and privileges).

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
  if e.id is null or e.id <> p_event_id or e.actor <> 'user' or e.type not in ('resolved')
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
  insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (v_uid, t.id, 'user', 'undone', d.before, d.after || jsonb_build_object('undone_event_id', e.id), p_now)
    returning id into v_event;

  return jsonb_build_object(
    'ok', true, 'thread_id', t.id, 'event_id', v_event, 'undone_event_id', e.id,
    'undone_action', case when e.type = 'resolved' and e.after ->> 'resolution' = 'done' then 'done' else 'resolve' end,
    'from_status', t.status, 'to_status', r.status
  );
end;
$$;

revoke all on function private.thread_undo_unguarded(uuid, bigint, timestamptz) from public, anon, authenticated;
