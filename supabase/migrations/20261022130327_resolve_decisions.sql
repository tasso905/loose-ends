-- S8: F11 Resolve with decision + reason, and the decisions write model (additive: one nullable
-- column, one unique key, policies, grants, one new function and a new body for thread_undo).
--
-- 1. decisions joins the write model (migration 20261021115926). It was FOR ALL, so the owner
--    could insert, rewrite or delete a decision through PostgREST: no thread_events row, any
--    decided_at, a reason_ai_summary the UI would label as AI although the user typed it, and a
--    reason_user rewritten later (rule 5: reasons are stored and shown verbatim). Now: own-row
--    SELECT only. Rows are written by public.thread_resolve() and removed only by cascade (thread
--    forgotten, account deleted) or by Undo of the resolution that wrote them (D44).
-- 2. A decision links to its resolution event (PRD F11 "decisions row linked to thread and
--    resolution event") through decisions.resolution_event_id, kept with its owner by a composite
--    key like every other child row.
-- 3. public.thread_resolve(): the Resolve sheet (open / waiting / snoozed → resolved with
--    resolution done, decided or not_needed). Mirrors transition() {type: "resolve"} in
--    lib/threads/transition.ts; tests/integration/thread-resolve.test.ts proves the two agree.
-- 4. Undo of a resolution as Decided also removes the decision it wrote, so an undone decision is
--    never answered from by Ask why. Same body as migration 20261021170903 plus that delete.

-- 1. Reads only ---------------------------------------------------------------------------------
drop policy decisions_own on public.decisions;
create policy decisions_select_own on public.decisions
  for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate, references, trigger on public.decisions from anon, authenticated;

-- 2. Link to the resolution event ---------------------------------------------------------------
alter table public.thread_events add constraint thread_events_id_user_key unique (id, user_id);
alter table public.decisions add column resolution_event_id bigint;
alter table public.decisions add constraint decisions_resolution_event_fk
  foreign key (resolution_event_id, user_id) references public.thread_events (id, user_id) on delete cascade;
create index decisions_resolution_event_idx on public.decisions (resolution_event_id);

-- 3. Resolve -------------------------------------------------------------------------------------
-- Limits mirror DECISION_CHOICE_MAX / DECISION_REASON_MAX in lib/threads/resolve.ts.
create function public.thread_resolve(
  p_thread_id uuid,
  p_from_status text,
  p_resolution text,
  p_choice text,
  p_reason text,
  p_now timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.threads;
  v_state jsonb;
  d record;
  v_event bigint;
  v_decision uuid;
  v_reason text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);

  if p_resolution is null or p_resolution not in ('done', 'decided', 'not_needed') then
    raise exception 'invalid resolution' using errcode = '22023';
  end if;
  -- Decided needs what was decided; the reason is optional (Skip saves none). Other resolutions
  -- carry neither. Text is stored exactly as typed (rule 5); a blank reason is no reason.
  if p_resolution = 'decided' then
    if private.is_blank(p_choice) or char_length(p_choice) > 300 then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    v_reason := case when private.is_blank(p_reason) then null else p_reason end;
    if char_length(v_reason) > 2000 then
      raise exception 'invalid reason' using errcode = '22023';
    end if;
  elsif p_choice is not null or p_reason is not null then
    raise exception 'only Decided records a decision' using errcode = '22023';
  end if;

  select * into t from public.threads where id = p_thread_id and user_id = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Stale page, a closed thread, or Done on a decision thread (D6: a decision thread's outcome is
  -- recorded, so the sheet offers Decided and Not needed) → invalid_transition, nothing written.
  if t.status is distinct from p_from_status or t.status not in ('open', 'waiting', 'snoozed')
     or (t.kind = 'decision' and p_resolution = 'done') then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  v_state := private.thread_state(t);
  -- closeAs(t, "resolved", resolution): a snooze date is meaningless once closed; waiting_on is kept.
  select * into d from private.state_diff(
    v_state,
    v_state || jsonb_build_object('status', 'resolved', 'resolution', p_resolution, 'resolved_at', private.iso(p_now), 'snoozed_until', null)
  );
  update public.threads set status = 'resolved', resolution = p_resolution, resolved_at = p_now, snoozed_until = null, updated_at = p_now
    where id = t.id;
  insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (v_uid, t.id, 'user', 'resolved', d.before, d.after, p_now)
    returning id into v_event;

  if p_resolution = 'decided' then
    -- The source facts at decision time, with their evidence ids, so Ask why still works if the
    -- thread is edited later (PRD Decision Memory).
    insert into public.decisions (user_id, thread_id, choice, reason_user, context_facts, decided_at, resolution_event_id)
    values (
      v_uid, t.id, p_choice, v_reason,
      coalesce((select jsonb_agg(jsonb_build_object('text', e.quote, 'evidence_id', e.id) order by e.id)
                from public.evidence e where e.thread_id = t.id and e.user_id = v_uid), '[]'::jsonb),
      p_now, v_event
    )
    returning id into v_decision;
  end if;

  return jsonb_build_object(
    'ok', true, 'thread_id', t.id, 'event_id', v_event, 'decision_id', v_decision,
    'resolution', p_resolution, 'from_status', t.status, 'to_status', 'resolved'
  );
end;
$$;

revoke all on function public.thread_resolve(uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.thread_resolve(uuid, text, text, text, text, timestamptz) to authenticated;

-- 4. Undo removes the decision its resolution wrote --------------------------------------------
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
  -- A resolution as Decided wrote a decision; undoing it removes that decision (D44: the state
  -- before the action had none).
  delete from public.decisions where resolution_event_id = e.id and user_id = v_uid;
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
