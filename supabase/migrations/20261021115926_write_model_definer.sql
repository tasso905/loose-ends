-- One write model for the trust tables (additive: grants and function attributes only).
--
-- Every write to sources, extractions, extraction_items, evidence, threads, thread_events and
-- suppressions goes through a SECURITY DEFINER function that checks auth.uid() itself, pins
-- search_path = '' and is executable by `authenticated` only:
--   S0  forget_thread
--   S2  start_source_extraction, retry_extraction, set_extraction_stage, complete_extraction,
--       fail_extraction, get_extraction (migration 20261020231312)
--   S3  accept_proposals, reject_proposals, undo_reject_proposals (migration 20261020225037)
--   S4  thread_done, thread_undo (migration 20261020231123, already definer)
-- Direct INSERT / UPDATE / DELETE through PostgREST is then revoked, so the RLS FOR ALL policies
-- only govern reads. The one direct write left is DELETE on one's own source (F13 "delete source
-- only"; RLS still limits it to the owner and the cascades and triggers below clean up after it).
--
-- Why the service role is not used instead: CLAUDE.md allows it only in cron/daily, account
-- deletion and inbound email. A definer function owned by the migration role, with an explicit
-- auth.uid() filter, gives the same server-side control per user without handing the app a key
-- that bypasses RLS for everyone.
--
-- Ordering: sorts after S3 (20261020225037) and S4 (20261020231123). It needs S3's functions to
-- exist, so it must be applied after S3's migration; S4's may come before or after.

-- S3: the bodies already filter every read and write on v_uid = auth.uid() and refuse ids that are
-- not the caller's (private.lock_own_items). Composite foreign keys (x_id, user_id) keep every
-- linked row with its owner. Only the security attribute changes; bodies are unchanged.
alter function public.accept_proposals(uuid, uuid[], timestamptz) security definer;
alter function public.reject_proposals(uuid, uuid[], timestamptz) security definer;
alter function public.undo_reject_proposals(uuid, uuid[]) security definer;

-- S0: forget_thread first checks the thread is the caller's (t.user_id = auth.uid(), else P0002);
-- every later statement is keyed by that thread, and the composite foreign keys mean only the
-- owner's rows can reference it. Body unchanged (latest: 20261019150508).
alter function public.forget_thread(uuid, boolean) security definer;

-- S0 cleanup triggers: they delete evidence when a proposal or source is deleted. As definer they
-- keep working for the owner's DELETE on sources once evidence DELETE is revoked. They act only on
-- rows linked to OLD, which is already the caller's (RLS on the triggering DELETE).
alter function public.extraction_items_delete_evidence() security definer set search_path = '';
alter function public.sources_delete_source_only_evidence() security definer set search_path = '';
revoke all on function public.extraction_items_delete_evidence(), public.sources_delete_source_only_evidence()
  from public, anon, authenticated;

-- S2 quote checks (migration 20261020231312) fire for every writer, including the service role
-- used by account deletion and test seeds, which has no usage on schema private. As definer they
-- run as their owner; they read only NEW/OLD and the row's own source. The column guards stay
-- invoker: they test current_user = 'authenticated' and are a second layer behind the revokes.
alter function private.extractions_verify() security definer;
alter function private.extraction_items_verify() security definer;
alter function private.evidence_verify() security definer;
revoke all on function private.extractions_verify(), private.extraction_items_verify(), private.evidence_verify()
  from public, anon, authenticated;

-- Helpers now called only from definer functions or definer triggers.
revoke all on function
  private.quote_in_text(text, text),
  private.evidence_verified(jsonb, text),
  private.brief_verified(jsonb, text),
  private.is_blank(text),
  private.proposal_thread_fields(jsonb, uuid, numeric),
  private.lock_own_items(uuid, uuid[])
from public, anon, authenticated;

-- Direct writes: reads stay (RLS: own rows only); writes go through the functions above.
revoke insert, update, delete, truncate, references, trigger on
  public.extractions, public.extraction_items, public.evidence, public.threads,
  public.thread_events, public.suppressions
from anon, authenticated;
revoke insert, update, truncate, references, trigger on public.sources from anon, authenticated;
revoke delete on public.sources from anon;
