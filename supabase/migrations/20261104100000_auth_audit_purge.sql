-- Account deletion also removes the user's entries from auth.audit_log_entries (user decision, S11;
-- rules 8, 9). Additive: one private table, two private helpers, three functions for the service role.
--
-- Deleting the auth user itself writes a `user_deleted` entry, so the purge runs after that delete.
-- By then the session is dead and the user can't retry, so a purge that fails needs another way to
-- finish: prepare() records the pending purge before anything is deleted, and cron/daily retries it
-- through auth_audit_purge_pending(). The pending row holds the email only until the purge succeeds.
--
-- Matching: an entry identifies the user when any string value in its payload, at any depth, equals
-- the user's id or email, ignoring case (actor_id, actor_username, traits.user_id, traits.user_email,
-- and any field Auth adds later). Whole values, never substrings: a@example.com must not match
-- aa@example.com. The nil id (`actor_id` of every service-role entry) and a non-email (the
-- `actor_username` "service_role") are refused, or the purge would take other users' entries.

create table private.auth_audit_purges (
  user_id uuid primary key,                     -- no foreign key: it outlives the user on purpose
  email text,
  created_at timestamptz not null default now()
);
alter table private.auth_audit_purges enable row level security;
revoke all on private.auth_audit_purges from public, anon, authenticated;

create function private.auth_audit_check_args(p_user_id uuid, p_email text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_user_id is null or p_user_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'invalid user' using errcode = '22023';
  end if;
  if p_email is not null and p_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.auth_audit_check_args(uuid, text) from public, anon, authenticated;

-- p_vars holds lower-cased `id` and `email`; the payload is lower-cased whole to compare with them.
create function private.auth_audit_matches(p_payload json, p_vars jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_payload is not null
    and jsonb_path_exists(lower(p_payload::text)::jsonb, '$.** ? (@ == $id || @ == $email)', p_vars);
$$;
revoke all on function private.auth_audit_matches(json, jsonb) from public, anon, authenticated;

-- Before anything is deleted: refuses if the purge could not run (so the account is not deleted into
-- a state that can't be finished) and records the pending purge. Deletes no entries: the deletion may
-- still fail, and a surviving account keeps its sign-in history.
create function public.auth_audit_purge_prepare(p_user_id uuid, p_email text) returns void
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
end;
$$;

-- After the auth user is deleted. Refuses while the user exists. Clears the pending row only when
-- nothing identifying the user is left. With no email only the id matches. The same applies when
-- someone has since signed up with that email: those entries are theirs, and the deleted user's own
-- entries still carry the deleted id.
create function public.auth_audit_purge(p_user_id uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_vars jsonb;
  v_deleted int;
  v_left int;
begin
  perform private.auth_audit_check_args(p_user_id, p_email);
  if exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user still exists' using errcode = '22023';
  end if;
  v_email := coalesce(p_email, (select q.email from private.auth_audit_purges q where q.user_id = p_user_id));
  if exists (select 1 from auth.users u where lower(u.email) = lower(v_email)) then
    v_email := null;
  end if;
  v_vars := jsonb_build_object('id', p_user_id::text, 'email', coalesce(lower(v_email), p_user_id::text));

  delete from auth.audit_log_entries a where private.auth_audit_matches(a.payload, v_vars);
  get diagnostics v_deleted = row_count;
  select count(*) into v_left from auth.audit_log_entries a where private.auth_audit_matches(a.payload, v_vars);
  if v_left = 0 then
    delete from private.auth_audit_purges q where q.user_id = p_user_id;
  end if;
  return jsonb_build_object('deleted', v_deleted, 'remaining', v_left);
end;
$$;

-- For cron/daily: finishes purges of users who are gone. A user who still exists a day later kept
-- their account (the deletion failed and they did not retry), so their purge is dropped.
create function public.auth_audit_purge_pending() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_out jsonb;
  v_purged int := 0;
  v_pending int := 0;
begin
  delete from private.auth_audit_purges q
    where q.created_at < now() - interval '1 day'
      and exists (select 1 from auth.users u where u.id = q.user_id);
  for r in
    select q.user_id, q.email from private.auth_audit_purges q
    where not exists (select 1 from auth.users u where u.id = q.user_id)
  loop
    begin
      v_out := public.auth_audit_purge(r.user_id, r.email);
      if (v_out ->> 'remaining')::int = 0 then v_purged := v_purged + 1; else v_pending := v_pending + 1; end if;
    exception when others then
      v_pending := v_pending + 1;
    end;
  end loop;
  return jsonb_build_object('purged', v_purged, 'pending', v_pending);
end;
$$;

revoke all on function public.auth_audit_purge_prepare(uuid, text) from public, anon, authenticated;
revoke all on function public.auth_audit_purge(uuid, text) from public, anon, authenticated;
revoke all on function public.auth_audit_purge_pending() from public, anon, authenticated;
grant execute on function public.auth_audit_purge_prepare(uuid, text) to service_role;
grant execute on function public.auth_audit_purge(uuid, text) to service_role;
grant execute on function public.auth_audit_purge_pending() to service_role;

-- Visible in a dry run: the table belongs to supabase_auth_admin, so the role running migrations has
-- to hold these privileges already. Without them prepare() refuses and account deletion fails safely.
do $$
begin
  if not (has_table_privilege('auth.audit_log_entries', 'select') and has_table_privilege('auth.audit_log_entries', 'delete')) then
    raise warning 'auth_audit_purge: % lacks select or delete on auth.audit_log_entries; account deletion will refuse until this is fixed', current_user;
  end if;
end;
$$;
