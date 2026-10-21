-- S4: F9 Done and its 8 s Undo (additive: new functions, a narrowed table privilege, no table changes).
--
-- thread_done   open / waiting / snoozed → resolved with resolution = done (D6), one transaction:
--               the thread update and a thread_events 'resolved' row with before/after.
-- thread_undo   undo of the thread's latest event, within 8 s of it (proposed D44 option a): the
--               event's `before` values are restored and an 'undone' event is appended. History is
--               never rewritten.
--
-- Both mirror transition() in lib/threads/transition.ts ({type: "done"} and {type: "undo"}). SQL
-- cannot call the TypeScript, so tests/integration/thread-done.test.ts proves the two agree.
--
-- Both are SECURITY DEFINER with an explicit owner check (user_id = auth.uid()) and an empty
-- search_path, so they behave the same whether or not the caller may write the tables directly.
-- Execute is granted to authenticated only.

-- An instant in the exact format of JavaScript's Date.toISOString() (UTC, milliseconds, `Z`), so
-- event before/after values compare equal to the TypeScript's.
create function private.iso(p timestamptz) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then null else to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
$$;

-- The 17 ThreadState keys (lib/threads/transition.ts) of a thread row, as the TypeScript holds them.
create function private.thread_state(t public.threads) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'title', t.title, 'kind', t.kind, 'next_action', t.next_action, 'counterparty', t.counterparty,
    'due_at', private.iso(t.due_at), 'due_certainty', t.due_certainty, 'due_time_known', t.due_time_known,
    'consequence', t.consequence, 'consequence_basis', t.consequence_basis, 'status', t.status,
    'resolution', t.resolution, 'waiting_on', t.waiting_on, 'expected_by', private.iso(t.expected_by),
    'snoozed_until', private.iso(t.snoozed_until), 'resolved_at', private.iso(t.resolved_at),
    'primary_source_id', t.primary_source_id, 'confidence', t.confidence
  )
$$;

-- transition()'s diff(): before/after hold only the keys whose values changed.
create function private.state_diff(p_before jsonb, p_after jsonb, out before jsonb, out after jsonb)
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, p_before -> k), '{}'::jsonb), coalesce(jsonb_object_agg(k, p_after -> k), '{}'::jsonb)
  from jsonb_object_keys(p_after) k
  where (p_before -> k) is distinct from (p_after -> k)
$$;

create function public.thread_done(p_thread_id uuid, p_from_status text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.threads;
  v_state jsonb;
  d record;
  v_event bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_now is null then raise exception 'p_now is required' using errcode = '22023'; end if;
  select * into t from public.threads where id = p_thread_id and user_id = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Stale page (the status it showed is no longer current), a closed thread, or a decision thread
  -- (D6: Resolve… instead) → invalid_transition, with nothing written.
  if t.status is distinct from p_from_status or t.status not in ('open', 'waiting', 'snoozed') or t.kind = 'decision' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  v_state := private.thread_state(t);
  -- closeAs(t, "resolved", "done"): a snooze date is meaningless once closed; waiting_on is kept.
  select * into d from private.state_diff(
    v_state,
    v_state || jsonb_build_object('status', 'resolved', 'resolution', 'done', 'resolved_at', private.iso(p_now), 'snoozed_until', null)
  );
  update public.threads set status = 'resolved', resolution = 'done', resolved_at = p_now, snoozed_until = null, updated_at = p_now
    where id = t.id;
  insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (v_uid, t.id, 'user', 'resolved', d.before, d.after, p_now)
    returning id into v_event;

  return jsonb_build_object('ok', true, 'thread_id', t.id, 'event_id', v_event, 'from_status', t.status, 'to_status', 'resolved');
end;
$$;

create function public.thread_undo(p_thread_id uuid, p_event_id bigint, p_now timestamptz)
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
  -- Only the latest event, only the user's own reversible action, only within 8 s (D44 a). The
  -- undoable event types mirror UNDOABLE_EVENT_TYPES in lib/threads/transition.ts.
  if e.id is null or e.id <> p_event_id or e.actor <> 'user' or e.type not in ('resolved')
     or p_now < e.created_at or p_now > e.created_at + interval '8 seconds' then
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

revoke all on function private.iso(timestamptz), private.thread_state(public.threads), private.state_diff(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.thread_done(uuid, text, timestamptz), public.thread_undo(uuid, bigint, timestamptz)
  from public, anon;
grant execute on function public.thread_done(uuid, text, timestamptz), public.thread_undo(uuid, bigint, timestamptz)
  to authenticated;

-- Status and fields change only through these functions (and transition()): a direct PostgREST
-- UPDATE on threads would change a thread without a thread_events row. Nothing else updates threads
-- (accept_proposals inserts; forget_thread deletes), so the privilege goes. Insert and delete stay
-- for S3's accept_proposals and forget_thread, which run as the caller.
revoke update on public.threads from anon, authenticated;
