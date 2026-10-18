-- Row-level security on every table: user_id = auth.uid() (profiles: id = auth.uid()).
-- The service role bypasses RLS and is used only in cron/daily, account deletion and inbound email.

alter table public.profiles         enable row level security;
alter table public.user_settings    enable row level security;
alter table public.sources          enable row level security;
alter table public.extractions      enable row level security;
alter table public.threads          enable row level security;
alter table public.extraction_items enable row level security;
alter table public.evidence         enable row level security;
alter table public.thread_events    enable row level security;
alter table public.decisions        enable row level security;
alter table public.usage_counters   enable row level security;

-- profiles and user_settings: read and update only. Rows are created by the sign-up trigger and
-- removed only by account deletion (service role; it must also delete the user's storage objects
-- through the Storage API, which a cascade cannot do).
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy user_settings_select_own on public.user_settings
  for select to authenticated using (user_id = (select auth.uid()));
create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy sources_own on public.sources
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy extractions_own on public.extractions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy threads_own on public.threads
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy extraction_items_own on public.extraction_items
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy evidence_own on public.evidence
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Append-only: select and insert only. Deletion happens via cascade from threads/profiles.
create policy thread_events_select_own on public.thread_events
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy thread_events_insert_own on public.thread_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy decisions_own on public.decisions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Rate-limit counters: users can read their own but never write them directly (they could reset
-- their limit). The only write path is consume_usage(), which can only add to the caller's count.
create policy usage_counters_select_own on public.usage_counters
  for select to authenticated using (user_id = (select auth.uid()));

-- Atomically checks and increments today's counter for the calling user. Returns true if the
-- action is allowed (and counted), false if the daily limit is reached. Days are UTC days, so
-- changing profiles.timezone cannot open a fresh "day" (the limit resets at midnight UTC).
-- Limits are fixed here (PRD: 30 extractions, 50 asks per user per day) so a caller cannot raise them.
-- Callers must treat any error from this function as a denial.
create function public.consume_usage(p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date;
  v_limit int;
  v_ok boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_kind = 'extraction' then v_limit := 30;
  elsif p_kind = 'ask' then v_limit := 50;
  else raise exception 'unknown usage kind %', p_kind;
  end if;

  v_day := (now() at time zone 'UTC')::date;

  insert into public.usage_counters (user_id, day) values (v_uid, v_day)
  on conflict (user_id, day) do nothing;

  if p_kind = 'extraction' then
    update public.usage_counters set extractions = extractions + 1
      where user_id = v_uid and day = v_day and extractions < v_limit
      returning true into v_ok;
  else
    update public.usage_counters set asks = asks + 1
      where user_id = v_uid and day = v_day and asks < v_limit
      returning true into v_ok;
  end if;
  return coalesce(v_ok, false);
end;
$$;
revoke all on function public.consume_usage(text) from public, anon;
grant execute on function public.consume_usage(text) to authenticated;

-- Storage (F3): private bucket "sources", objects at {user_id}/{source_id}.
insert into storage.buckets (id, name, public, file_size_limit)
values ('sources', 'sources', false, 10485760)
on conflict (id) do nothing;

create policy sources_bucket_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy sources_bucket_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy sources_bucket_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
