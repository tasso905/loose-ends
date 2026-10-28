-- S11 (F13, F9 Forget, rule 8): source deletion through one SECURITY DEFINER path, and a queue
-- that makes sure every deleted source's file is really removed from Storage. Additive: one table,
-- one trigger, three functions.
--
-- Why a queue: Storage files cannot be deleted from SQL (a row removed from storage.objects leaves
-- the file behind), so the server action removes them through the Storage API after the rows are
-- gone (the owner may delete a file only once no sources row owns it, migration 20261022121048).
-- A trigger records every deleted source's storage_path in the same transaction as the row
-- deletion, whoever deleted it (delete_source, forget_thread with "also delete source", or a
-- direct DELETE). The action calls storage_deletions_settle() to get the queued paths, removes
-- those files, and settles again: an entry is cleared only when storage.objects no longer has the
-- file. Anything left (a failed Storage call)
-- stays queued; the next delete, a retry, or cron/daily (service role) finishes it.
-- Account deletion cascades through sources while the profile is already gone; those files are
-- swept by deleteAccount() (lib/account/deleteAccount.ts), so the trigger does not queue them.

create table private.storage_deletions (
  -- Account deletion takes the queue rows with it; deleteAccount() sweeps the whole folder anyway.
  user_id uuid not null references public.profiles on delete cascade,
  bucket text not null default 'sources',
  path text not null,
  created_at timestamptz not null default now(),
  primary key (bucket, path)
);
revoke all on private.storage_deletions from public, anon, authenticated;

create function private.queue_source_file_deletion() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.storage_path is not null and exists (select 1 from public.profiles p where p.id = old.user_id) then
    insert into private.storage_deletions (user_id, path) values (old.user_id, old.storage_path)
      on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;
revoke all on function private.queue_source_file_deletion() from public, anon, authenticated;

create trigger sources_queue_file_deletion
  after delete on public.sources
  for each row execute function private.queue_source_file_deletion();

-- Delete one of the caller's sources.
--   p_everything = false: "Delete source only". The source row, its extractions, its pending
--     proposals and its brief go; threads keep their quote excerpts (evidence.source_id is set
--     null, the source line reads `Source deleted`).
--   p_everything = true: "Delete source and everything from it". Every thread that came from it is
--     forgotten first (forget_thread: thread, evidence, history, decision, originating proposals;
--     only the suppression hash stays), then the source.
-- Returns counts and whether a file was queued; not_found for another user's or a missing source.
create function public.delete_source(p_source_id uuid, p_everything boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  s public.sources;
  v_threads int := 0;
  t record;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_everything is null then raise exception 'invalid option' using errcode = '22023'; end if;

  select * into s from public.sources where id = p_source_id and user_id = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_everything then
    for t in select d.id from private.source_thread_ids(s.id, v_uid) d loop
      perform public.forget_thread(t.id, false);
      v_threads := v_threads + 1;
    end loop;
  end if;

  delete from public.sources where id = s.id;

  return jsonb_build_object('ok', true, 'source_id', s.id, 'threads_forgotten', v_threads, 'file_queued', s.storage_path is not null);
end;
$$;

-- Threads that came from a source: its primary source, an accepted proposal of one of its
-- extractions, or evidence quoting it.
create function private.source_thread_ids(p_source_id uuid, p_uid uuid) returns table (id uuid)
language sql stable security definer set search_path = '' as $$
  select t.id from public.threads t
  where t.user_id = p_uid and (
    t.primary_source_id = p_source_id
    or t.id in (select ei.thread_id from public.extraction_items ei join public.extractions e on e.id = ei.extraction_id
                where e.source_id = p_source_id and ei.user_id = p_uid and ei.thread_id is not null)
    or t.id in (select ev.thread_id from public.evidence ev where ev.source_id = p_source_id and ev.user_id = p_uid and ev.thread_id is not null)
  )
$$;
revoke all on function private.source_thread_ids(uuid, uuid) from public, anon, authenticated;

revoke all on function public.delete_source(uuid, boolean) from public, anon;
grant execute on function public.delete_source(uuid, boolean) to authenticated;

-- Clears the caller's queue entries whose file is really gone and returns the paths still present.
create function public.storage_deletions_settle() returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  delete from private.storage_deletions d
    where d.user_id = v_uid and d.bucket = 'sources'
      and not exists (select 1 from storage.objects o where o.bucket_id = d.bucket and o.name = d.path);
  return coalesce((select array_agg(d.path order by d.path) from private.storage_deletions d where d.user_id = v_uid and d.bucket = 'sources'), '{}');
end;
$$;
revoke all on function public.storage_deletions_settle() from public, anon;
grant execute on function public.storage_deletions_settle() to authenticated;
