-- S12: F9 thread actions beyond Done and Resolve (additive: new functions and a new body for
-- private.thread_undo_unguarded; no table or column changes).
--
-- thread_mark_waiting  open → waiting (waiting_on required, expected_by optional)
-- thread_snooze        open → snoozed (snoozed_until in the future)
-- thread_dismiss       open / waiting / snoozed → dismissed, and a 'dismissed' suppression for each
--                      hash of the thread's proposals, so re-extraction of the same source does not
--                      propose it again (F9 acceptance)
-- thread_back_to_me    waiting → open (clears waiting_on, expected_by)
-- thread_wake          snoozed → open (Wake now; clears snoozed_until)
-- thread_reopen        resolved / dismissed → open; keeps any decision row; a dismissed thread's
--                      suppression is deleted (PRD lifecycle table)
-- thread_edit          any status, same status; only the fields given change (title, kind,
--                      next_action, counterparty, consequence, due_at, due_time_known, and
--                      waiting_on / expected_by while waiting, snoozed_until while snoozed)
--
-- Each mirrors transition() in lib/threads/transition.ts; tests/integration/thread-actions.test.ts
-- proves the two agree. Each is one transaction: the thread update and a thread_events row with
-- before/after (only the changed keys), written at p_now. `p_from_status` is the status the page
-- showed: a different current status is a stale page → invalid_transition, nothing written.
-- p_now is checked against the database clock (private.assert_now, migration 20261021131140).
-- Malformed input (blank names, over-long text, a snooze date not in the future) raises 22023,
-- which the app maps to its generic save failure; the app validates first, so only a forged
-- request gets there.
--
-- Undo (D44) now also reverses Mark waiting, Snooze, Dismiss, Back to me, Wake now and Edit
-- (event types status_changed, snoozed, edited), within the same 12 s window. Undoing a Dismiss
-- deletes the suppression it wrote. Reopen is not undoable (not in D8's reversible list).

-- Writes the thread to p_next (a private.thread_state() object) and appends one event with the
-- changed keys. Returns the event id, or null when nothing changed (nothing is written then).
create function private.thread_commit(t public.threads, p_next jsonb, p_type text, p_now timestamptz)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb := private.thread_state(t);
  r public.threads;
  d record;
  v_event bigint;
begin
  select * into d from private.state_diff(v_state, p_next);
  if d.after = '{}'::jsonb then return null; end if;
  r := jsonb_populate_record(t, p_next);
  update public.threads set
    title = r.title, kind = r.kind, next_action = r.next_action, counterparty = r.counterparty, due_at = r.due_at,
    due_certainty = r.due_certainty, due_time_known = r.due_time_known, consequence = r.consequence,
    consequence_basis = r.consequence_basis, status = r.status, resolution = r.resolution, waiting_on = r.waiting_on,
    expected_by = r.expected_by, snoozed_until = r.snoozed_until, resolved_at = r.resolved_at,
    primary_source_id = r.primary_source_id, confidence = r.confidence, updated_at = p_now
  where id = t.id;
  insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (t.user_id, t.id, 'user', p_type, d.before, d.after, p_now)
    returning id into v_event;
  return v_event;
end;
$$;

-- The caller's thread, locked, or null. Checks the caller and the clock first.
create function private.thread_for_action(p_thread_id uuid, p_now timestamptz) returns public.threads
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);
  select * into t from public.threads where id = p_thread_id and user_id = auth.uid() for update;
  return t;
end;
$$;

create function private.action_result(t public.threads, p_event bigint, p_to text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', true, 'thread_id', t.id, 'event_id', p_event, 'from_status', t.status, 'to_status', p_to)
$$;

create function public.thread_mark_waiting(p_thread_id uuid, p_from_status text, p_waiting_on text, p_expected_by timestamptz, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if private.is_blank(p_waiting_on) or char_length(p_waiting_on) > 100 then
    raise exception 'invalid waiting_on' using errcode = '22023';
  end if;
  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status is distinct from p_from_status or t.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  return private.action_result(t, private.thread_commit(t,
    private.thread_state(t) || jsonb_build_object('status', 'waiting', 'waiting_on', p_waiting_on, 'expected_by', private.iso(p_expected_by)),
    'status_changed', p_now), 'waiting');
end;
$$;

create function public.thread_snooze(p_thread_id uuid, p_from_status text, p_until timestamptz, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_until is null or p_until <= p_now then raise exception 'snooze date must be in the future' using errcode = '22023'; end if;
  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Snoozing a waiting thread is not allowed in the MVP (expected_by serves that purpose).
  if t.status is distinct from p_from_status or t.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  return private.action_result(t, private.thread_commit(t,
    private.thread_state(t) || jsonb_build_object('status', 'snoozed', 'snoozed_until', private.iso(p_until)),
    'snoozed', p_now), 'snoozed');
end;
$$;

create function public.thread_dismiss(p_thread_id uuid, p_from_status text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
  v_event bigint;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status is distinct from p_from_status or t.status not in ('open', 'waiting', 'snoozed') then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  -- closeAs(t, "dismissed", null): no resolution; a snooze date is meaningless once closed.
  v_event := private.thread_commit(t,
    private.thread_state(t) || jsonb_build_object('status', 'dismissed', 'resolution', null, 'snoozed_until', null),
    'status_changed', p_now);
  -- Suppression (F9): the hashes of the proposals behind this thread, whether the proposal row is
  -- still there or only its kept hash is (migration 20261104090000). Linked to the thread so
  -- Reopen and Undo remove exactly these. A hash already suppressed (rejected elsewhere) stays as it is.
  insert into public.suppressions (user_id, suppression_hash, reason, thread_id, created_at)
    select t.user_id, h.suppression_hash, 'dismissed', t.id, p_now
    from (
      select i.suppression_hash from public.extraction_items i
        where i.thread_id = t.id and i.user_id = t.user_id and i.suppression_hash is not null
      union
      select k.suppression_hash from private.thread_suppression_hashes k
        where k.thread_id = t.id and k.user_id = t.user_id
    ) h
    on conflict (user_id, suppression_hash) do nothing;
  return private.action_result(t, v_event, 'dismissed');
end;
$$;

create function public.thread_back_to_me(p_thread_id uuid, p_from_status text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status is distinct from p_from_status or t.status <> 'waiting' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  return private.action_result(t, private.thread_commit(t,
    private.thread_state(t) || jsonb_build_object('status', 'open', 'waiting_on', null, 'expected_by', null),
    'status_changed', p_now), 'open');
end;
$$;

create function public.thread_wake(p_thread_id uuid, p_from_status text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status is distinct from p_from_status or t.status <> 'snoozed' then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  return private.action_result(t, private.thread_commit(t,
    private.thread_state(t) || jsonb_build_object('status', 'open', 'snoozed_until', null),
    'status_changed', p_now), 'open');
end;
$$;

create function public.thread_reopen(p_thread_id uuid, p_from_status text, p_now timestamptz)
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
    delete from public.suppressions s where s.thread_id = t.id and s.user_id = t.user_id and s.reason = 'dismissed';
  end if;
  return private.action_result(t, v_event, 'open');
end;
$$;

-- Edit (transition() edit()): only the keys in p_fields change. A refusal that depends on the
-- thread's current state is invalid_transition; a malformed value raises 22023.
create function public.thread_edit(p_thread_id uuid, p_from_status text, p_fields jsonb, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.threads;
  v jsonb;
  f jsonb := coalesce(p_fields, '{}'::jsonb);
  v_due timestamptz;
  v_at timestamptz;
  v_known boolean;
  v_text text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if jsonb_typeof(f) <> 'object' or exists (
    select 1 from jsonb_object_keys(f) k
    where k <> all (array['title', 'kind', 'next_action', 'counterparty', 'consequence', 'due_at', 'due_time_known',
                          'waiting_on', 'expected_by', 'snoozed_until'])
  ) then
    raise exception 'unknown field' using errcode = '22023';
  end if;
  -- Text fields: a string within its limit (EDIT_LIMITS in lib/threads/transition.ts), or null
  -- where the field is optional. Title and waiting_on cannot be blank.
  if f ? 'title' and (jsonb_typeof(f -> 'title') <> 'string' or private.is_blank(f ->> 'title') or char_length(f ->> 'title') > 120) then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if f ? 'waiting_on' and (jsonb_typeof(f -> 'waiting_on') <> 'string' or private.is_blank(f ->> 'waiting_on') or char_length(f ->> 'waiting_on') > 100) then
    raise exception 'invalid waiting_on' using errcode = '22023';
  end if;
  if (f ? 'next_action' and jsonb_typeof(f -> 'next_action') not in ('string', 'null'))
     or char_length(f ->> 'next_action') > 300
     or (f ? 'counterparty' and jsonb_typeof(f -> 'counterparty') not in ('string', 'null'))
     or char_length(f ->> 'counterparty') > 100
     or (f ? 'consequence' and jsonb_typeof(f -> 'consequence') not in ('string', 'null'))
     or char_length(f ->> 'consequence') > 300
     or (f ? 'kind' and coalesce(f ->> 'kind', '') <> all (array['commitment', 'request', 'waiting_on', 'admin', 'decision']))
     or (f ? 'due_time_known' and jsonb_typeof(f -> 'due_time_known') <> 'boolean')
     or (f ? 'due_at' and jsonb_typeof(f -> 'due_at') not in ('string', 'null'))
     or (f ? 'expected_by' and jsonb_typeof(f -> 'expected_by') not in ('string', 'null'))
     or (f ? 'snoozed_until' and jsonb_typeof(f -> 'snoozed_until') <> 'string') then
    raise exception 'invalid field' using errcode = '22023';
  end if;

  t := private.thread_for_action(p_thread_id, p_now);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status is distinct from p_from_status then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  v := private.thread_state(t);
  if f ? 'title' then v := v || jsonb_build_object('title', f -> 'title'); end if;
  if f ? 'kind' then
    -- Changing to or from waiting_on would change status; that goes through Mark waiting / Back to me.
    if ((f ->> 'kind') = 'waiting_on') <> (t.kind = 'waiting_on') and t.status = 'waiting' then
      return jsonb_build_object('ok', false, 'error', 'invalid_transition');
    end if;
    v := v || jsonb_build_object('kind', f -> 'kind');
  end if;
  if f ? 'next_action' then v := v || jsonb_build_object('next_action', f -> 'next_action'); end if;
  if f ? 'counterparty' then v := v || jsonb_build_object('counterparty', f -> 'counterparty'); end if;
  if f ? 'consequence' then
    v := v || jsonb_build_object('consequence', f -> 'consequence');
    if jsonb_typeof(f -> 'consequence') = 'null' then v := v || jsonb_build_object('consequence_basis', null); end if;
  end if;
  if f ? 'due_at' then
    v_due := (f ->> 'due_at')::timestamptz;
    v_known := coalesce((f ->> 'due_time_known')::boolean, false);
    -- A date the user set is not an assumption (only the user edits through this function).
    v := v || jsonb_build_object(
      'due_at', private.iso(v_due),
      'due_certainty', case when v_due is null then 'none' else 'explicit' end,
      'due_time_known', case when v_due is null then false else v_known end);
  elsif f ? 'due_time_known' then
    if t.due_at is null then return jsonb_build_object('ok', false, 'error', 'invalid_transition'); end if;
    v := v || jsonb_build_object('due_time_known', f -> 'due_time_known');
  end if;
  if f ? 'waiting_on' or f ? 'expected_by' then
    if t.status <> 'waiting' then return jsonb_build_object('ok', false, 'error', 'invalid_transition'); end if;
    if f ? 'waiting_on' then v := v || jsonb_build_object('waiting_on', f -> 'waiting_on'); end if;
    if f ? 'expected_by' then
      v_at := (f ->> 'expected_by')::timestamptz;
      v := v || jsonb_build_object('expected_by', private.iso(v_at));
    end if;
  end if;
  if f ? 'snoozed_until' then
    v_at := (f ->> 'snoozed_until')::timestamptz;
    -- Same rule as Snooze: the date must be in the future.
    if t.status <> 'snoozed' then return jsonb_build_object('ok', false, 'error', 'invalid_transition'); end if;
    if v_at <= p_now then raise exception 'snooze date must be in the future' using errcode = '22023'; end if;
    v := v || jsonb_build_object('snoozed_until', private.iso(v_at));
  end if;

  return private.action_result(t, private.thread_commit(t, v, 'edited', p_now), t.status);
end;
$$;

-- Undo (D44): the same body as migration 20261022130327 with the S12 event types added, the
-- Dismiss suppression removed on undo, and the undone action named for analytics.
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
    delete from public.suppressions s where s.thread_id = t.id and s.user_id = v_uid and s.reason = 'dismissed';
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

revoke all on function
  private.thread_commit(public.threads, jsonb, text, timestamptz),
  private.thread_for_action(uuid, timestamptz),
  private.action_result(public.threads, bigint, text),
  private.thread_undo_unguarded(uuid, bigint, timestamptz)
from public, anon, authenticated;

revoke all on function
  public.thread_mark_waiting(uuid, text, text, timestamptz, timestamptz),
  public.thread_snooze(uuid, text, timestamptz, timestamptz),
  public.thread_dismiss(uuid, text, timestamptz),
  public.thread_back_to_me(uuid, text, timestamptz),
  public.thread_wake(uuid, text, timestamptz),
  public.thread_reopen(uuid, text, timestamptz),
  public.thread_edit(uuid, text, jsonb, timestamptz)
from public, anon;
grant execute on function
  public.thread_mark_waiting(uuid, text, text, timestamptz, timestamptz),
  public.thread_snooze(uuid, text, timestamptz, timestamptz),
  public.thread_dismiss(uuid, text, timestamptz),
  public.thread_back_to_me(uuid, text, timestamptz),
  public.thread_wake(uuid, text, timestamptz),
  public.thread_reopen(uuid, text, timestamptz),
  public.thread_edit(uuid, text, jsonb, timestamptz)
to authenticated;
