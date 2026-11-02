-- S9b (D58): "Add a reason now" (SITE_CONTRACT §2.11, CONTENT_MODEL §10). Additive: one function.
--
-- A decision saved without a reason (Skip) can get one later, once. decisions stays SELECT-only for
-- clients (migration 20261022130327); this SECURITY DEFINER function is the only writer:
--   - only the owner (auth.uid()), only while reason_user is null, so a recorded reason is never
--     rewritten (rule 5: reasons are stored and shown verbatim);
--   - the same checks as Resolve: not blank (private.is_blank), at most 2,000 characters
--     (DECISION_REASON_MAX in lib/threads/transition.ts);
--   - the text is stored exactly as sent (no trim);
--   - appends a `reason_added` thread_events row with the before and after values, so history is
--     never rewritten. The thread row itself is not changed.
-- decisions.search is a generated column, so Ask why finds the new reason at once.

create function public.decision_add_reason(p_decision_id uuid, p_reason text, p_now timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  d public.decisions;
  v_event bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);
  if private.is_blank(p_reason) or char_length(p_reason) > 2000 then
    raise exception 'invalid reason' using errcode = '22023';
  end if;

  select * into d from public.decisions where id = p_decision_id and user_id = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- A reason, once recorded, is never replaced (stale page or a second tab: nothing is written).
  if d.reason_user is not null then return jsonb_build_object('ok', false, 'error', 'invalid_transition'); end if;

  update public.decisions set reason_user = p_reason where id = d.id;
  insert into public.thread_events (user_id, thread_id, actor, type, before, after, created_at)
    values (
      v_uid, d.thread_id, 'user', 'reason_added',
      jsonb_build_object('decision_id', d.id, 'reason_user', null),
      jsonb_build_object('decision_id', d.id, 'reason_user', p_reason),
      p_now
    )
    returning id into v_event;

  return jsonb_build_object('ok', true, 'decision_id', d.id, 'thread_id', d.thread_id, 'event_id', v_event, 'reason_user', p_reason);
end;
$$;

revoke all on function public.decision_add_reason(uuid, text, timestamptz) from public, anon;
grant execute on function public.decision_add_reason(uuid, text, timestamptz) to authenticated;
