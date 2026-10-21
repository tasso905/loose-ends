-- Clock guard for the definer functions that take the caller's clock (additive: one private table,
-- private helpers, and public wrappers with unchanged signatures; no table or column changes).
--
-- Why: thread_done, thread_undo, accept_proposals, reject_proposals and get_extraction take p_now
-- from getNow() so tests stay deterministic, but they are callable directly through PostgREST. A
-- signed-in user could pass any instant: undo a Done minutes later (p_now = the Done's time + 1 s),
-- write thread_events.created_at or threads.resolved_at at any instant, or keep a running
-- extraction from timing out. Own data only (every body filters on auth.uid()), but the 8 s Undo
-- window (proposed D44 a) and the append-only history must not depend on the caller's honesty.
--
-- What: each public function becomes a thin SECURITY DEFINER wrapper that checks p_now against the
-- database's own now() before calling the unchanged body, which moves to schema private under a
-- new name and is no longer executable by API roles. The tolerance lives in private.clock_guard
-- (default 5 s; app servers and the database are NTP-synced to well under a second).
--
-- Why 5 s and not 30 s: an accepted p_now can be up to the tolerance T off on each of the two
-- calls, so a direct caller can stretch the 8 s Undo window to at most 8 s + 2T. T = 5 s keeps that
-- under 20 s; at T = 30 s an Undo 30 s late would still succeed.
--
-- Refusals: thread_undo answers invalid_transition (the Undo window cannot be shown to be open, the
-- same answer as an expired window). The others raise 22023, which the services map to their
-- generic save/load failure; with an honest server clock this never happens.
--
-- Not guarded: start_source_extraction. It uses p_now only to default the reference date when the
-- user gave none, the caller can set p_reference_date to any date anyway, and /add passes the
-- per-user demo date there in DEMO_MODE (D12), which is by design far from now().
--
-- Tests that use synthetic instants (PGlite) widen the tolerance in private.clock_guard, which only
-- the migration owner can write (schema private is not exposed; API roles have no table grants).

create table private.clock_guard (
  id boolean primary key default true check (id),
  max_skew interval not null check (max_skew > interval '0 seconds')
);
insert into private.clock_guard (max_skew) values (interval '5 seconds');
revoke all on table private.clock_guard from public, anon, authenticated;

-- True when p_now is within the tolerance of the database clock. now() is the transaction start,
-- the same instant for every statement of the call.
create function private.now_within_skew(p_now timestamptz) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_max interval;
begin
  if p_now is null then raise exception 'p_now is required' using errcode = '22023'; end if;
  select g.max_skew into v_max from private.clock_guard g where g.id;
  v_max := coalesce(v_max, interval '5 seconds');
  return p_now between now() - v_max and now() + v_max;
end;
$$;

create function private.assert_now(p_now timestamptz) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.now_within_skew(p_now) then
    raise exception 'p_now is too far from the database clock' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.now_within_skew(timestamptz), private.assert_now(timestamptz) from public, anon, authenticated;

-- Move each body out of the API (same code, new name), then put a guarded wrapper in its place.
alter function public.thread_done(uuid, text, timestamptz) set schema private;
alter function private.thread_done(uuid, text, timestamptz) rename to thread_done_unguarded;
alter function public.thread_undo(uuid, bigint, timestamptz) set schema private;
alter function private.thread_undo(uuid, bigint, timestamptz) rename to thread_undo_unguarded;
alter function public.accept_proposals(uuid, uuid[], timestamptz) set schema private;
alter function private.accept_proposals(uuid, uuid[], timestamptz) rename to accept_proposals_unguarded;
alter function public.reject_proposals(uuid, uuid[], timestamptz) set schema private;
alter function private.reject_proposals(uuid, uuid[], timestamptz) rename to reject_proposals_unguarded;
alter function public.get_extraction(uuid, timestamptz) set schema private;
alter function private.get_extraction(uuid, timestamptz) rename to get_extraction_unguarded;

revoke all on function
  private.thread_done_unguarded(uuid, text, timestamptz),
  private.thread_undo_unguarded(uuid, bigint, timestamptz),
  private.accept_proposals_unguarded(uuid, uuid[], timestamptz),
  private.reject_proposals_unguarded(uuid, uuid[], timestamptz),
  private.get_extraction_unguarded(uuid, timestamptz)
from public, anon, authenticated;

create function public.thread_done(p_thread_id uuid, p_from_status text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);
  return private.thread_done_unguarded(p_thread_id, p_from_status, p_now);
end;
$$;

create function public.thread_undo(p_thread_id uuid, p_event_id bigint, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.now_within_skew(p_now) then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  return private.thread_undo_unguarded(p_thread_id, p_event_id, p_now);
end;
$$;

create function public.accept_proposals(p_extraction_id uuid, p_item_ids uuid[], p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);
  return private.accept_proposals_unguarded(p_extraction_id, p_item_ids, p_now);
end;
$$;

create function public.reject_proposals(p_extraction_id uuid, p_item_ids uuid[], p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  perform private.assert_now(p_now);
  return private.reject_proposals_unguarded(p_extraction_id, p_item_ids, p_now);
end;
$$;

create function public.get_extraction(p_extraction_id uuid, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  perform private.assert_now(p_now);
  return private.get_extraction_unguarded(p_extraction_id, p_now);
end;
$$;

revoke all on function
  public.thread_done(uuid, text, timestamptz),
  public.thread_undo(uuid, bigint, timestamptz),
  public.accept_proposals(uuid, uuid[], timestamptz),
  public.reject_proposals(uuid, uuid[], timestamptz),
  public.get_extraction(uuid, timestamptz)
from public, anon;
grant execute on function
  public.thread_done(uuid, text, timestamptz),
  public.thread_undo(uuid, bigint, timestamptz),
  public.accept_proposals(uuid, uuid[], timestamptz),
  public.reject_proposals(uuid, uuid[], timestamptz),
  public.get_extraction(uuid, timestamptz)
to authenticated;
