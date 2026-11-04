-- Account deletion's final sweep can fail after the auth user is gone, and then no one can retry: the
-- session is dead (rule 8, S11). Files under that user's Storage prefix have no queue entry (one
-- uploaded in the race never had a source row), so cron/daily finishes them from this list. Additive:
-- one private table holding only the id, and two functions for the service role. The Storage API does
-- the removing, so the database only answers who is pending and whether a prefix is empty.

create table private.account_file_purges (
  user_id uuid primary key,                     -- no foreign key: it outlives the user on purpose
  created_at timestamptz not null default now()
);
alter table private.account_file_purges enable row level security;
revoke all on private.account_file_purges from public, anon, authenticated;

-- The one prepare step for account deletion now records this too, in the same transaction.
create or replace function public.auth_audit_purge_prepare(p_user_id uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := p_email;
begin
  perform private.auth_audit_check_args(p_user_id, p_email);
  -- Two calls: has_table_privilege with a list is true when ANY of them is held.
  if not (has_table_privilege('auth.audit_log_entries', 'select') and has_table_privilege('auth.audit_log_entries', 'delete')) then
    raise exception 'cannot purge auth.audit_log_entries' using errcode = '42501';
  end if;
  if v_email is null then
    select u.email into v_email from auth.users u where u.id = p_user_id;
  end if;
  insert into private.auth_audit_purges (user_id, email) values (p_user_id, v_email)
    on conflict (user_id) do update set email = coalesce(excluded.email, private.auth_audit_purges.email), created_at = now();
  insert into private.account_file_purges (user_id) values (p_user_id)
    on conflict (user_id) do update set created_at = now();
end;
$$;

-- For cron/daily: the users who are gone, oldest first. A user who still exists a day later kept their
-- account (the deletion failed and they did not retry), so their row is dropped and their files stay.
create function public.account_file_purges_pending(p_limit int default 100) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  delete from private.account_file_purges q
    where q.created_at < now() - interval '1 day'
      and exists (select 1 from auth.users u where u.id = q.user_id);
  select coalesce(array_agg(x.user_id), '{}') into v_ids from (
    select q.user_id from private.account_file_purges q
    where not exists (select 1 from auth.users u where u.id = q.user_id)
    order by q.created_at
    limit p_limit
  ) x;
  return v_ids;
end;
$$;

-- Clears the row only when nothing is left under the user's prefix, and says whether it did. Refuses
-- while the user exists.
create function public.account_file_purge_clear(p_user_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.auth_audit_check_args(p_user_id, null);
  if exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user still exists' using errcode = '22023';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'sources' and o.name like p_user_id::text || '/%') then
    return false;
  end if;
  delete from private.account_file_purges q where q.user_id = p_user_id;
  return true;
end;
$$;

revoke all on function public.account_file_purges_pending(int) from public, anon, authenticated;
revoke all on function public.account_file_purge_clear(uuid) from public, anon, authenticated;
grant execute on function public.account_file_purges_pending(int) to service_role;
grant execute on function public.account_file_purge_clear(uuid) to service_role;
