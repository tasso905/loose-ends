-- S11 follow-ups (rule 8). Additive: one function for cron/daily, one private table and two triggers.
--
-- 1. S11-D3: the Storage deletion queue needs a finisher that does not depend on the user coming
--    back. cron/daily uses the service role, which has no usage on schema private, and
--    storage_deletions_settle() needs auth.uid(). So one narrow function, for the service role only:
--    no access to schema private is granted.
--
-- 2. S11-D5: the Forget dialog promises a one-way fingerprint stays. The hash lives on
--    extraction_items, which Delete source only removes, so a later Forget of the surviving thread
--    had no hash to keep. The hash now outlives the proposal: it is held for the thread in
--    private.thread_suppression_hashes, and becomes a suppression if the thread is forgotten. Rows
--    hold only the thread id and the hash, and go with the thread.

-- Clears queue entries whose file is gone, across all users, and returns up to p_limit paths still
-- present, oldest first. The caller removes those files through the Storage API and calls this again.
-- An entry is cleared only when storage.objects no longer has the file. An entry whose path a live
-- source owns again is dropped, not returned: that file is not to be deleted.
create function public.storage_deletions_sweep(p_limit int default 1000) returns text[]
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  delete from private.storage_deletions d
    where d.bucket = 'sources'
      and (
        not exists (select 1 from storage.objects o where o.bucket_id = d.bucket and o.name = d.path)
        or exists (select 1 from public.sources s where s.user_id = d.user_id and s.storage_path = d.path)
      );
  return coalesce((
    select array_agg(x.path order by x.created_at, x.path)
    from (
      select d.path, d.created_at from private.storage_deletions d
      where d.bucket = 'sources'
      order by d.created_at, d.path
      limit p_limit
    ) x
  ), '{}');
end;
$$;
revoke all on function public.storage_deletions_sweep(int) from public, anon, authenticated;
grant execute on function public.storage_deletions_sweep(int) to service_role;

create table private.thread_suppression_hashes (
  thread_id uuid not null references public.threads (id) on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  suppression_hash text not null,
  primary key (thread_id, suppression_hash)
);
revoke all on private.thread_suppression_hashes from public, anon, authenticated;

-- Any accepted proposal being deleted, by any path, leaves its hash with its thread.
create function private.keep_thread_suppression_hash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.thread_id is not null and old.suppression_hash is not null
     and exists (select 1 from public.threads t where t.id = old.thread_id) then
    insert into private.thread_suppression_hashes (thread_id, user_id, suppression_hash)
      values (old.thread_id, old.user_id, old.suppression_hash)
      on conflict (thread_id, suppression_hash) do nothing;
  end if;
  return old;
end;
$$;
revoke all on function private.keep_thread_suppression_hash() from public, anon, authenticated;

create trigger extraction_items_keep_suppression_hash
  before delete on public.extraction_items
  for each row execute function private.keep_thread_suppression_hash();

-- forget_thread is the only path that deletes a thread on its own. Account deletion cascades here
-- with the profile already gone, and then there is nothing to keep (D14), so nothing is written.
create function private.suppress_kept_hashes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p where p.id = old.user_id) then
    insert into public.suppressions (user_id, suppression_hash, reason, thread_id)
      select old.user_id, h.suppression_hash, 'forgotten', null
      from private.thread_suppression_hashes h
      where h.thread_id = old.id
      on conflict (user_id, suppression_hash) do update set reason = 'forgotten', thread_id = null;
  end if;
  return old;
end;
$$;
revoke all on function private.suppress_kept_hashes() from public, anon, authenticated;

create trigger threads_suppress_kept_hashes
  before delete on public.threads
  for each row execute function private.suppress_kept_hashes();
