-- Loose Ends: initial schema (PRD v1.1 "Database Schema").
-- Additive only during Build Fest: never drop or rename columns in later migrations.
--
-- Deviations from the PRD SQL block, all additive and reported to the program manager:
--   * evidence.quote_hash: named in PRD "Explainability & Source Attribution" and needed by F9
--     ("matched by source + quote hash") but missing from the SQL block.
--   * threads.due_time_known: DESIGN_STANDARD "Dates and numbers" says date-only deadlines never
--     show a time, so the row must record whether the source or user gave one.
--   * usage_counters: the PRD's "Postgres counter table per user per day" for rate limiting.
--   * Indexes are given explicit names so later migrations can refer to them.

create extension if not exists pg_trgm with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  aliases text[] not null default '{}',          -- names/emails that mean "me"
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key references public.profiles on delete cascade,
  digest_enabled boolean not null default false,
  digest_hour smallint not null default 8,
  disabled_item_types text[] not null default '{}',
  keep_source_text boolean not null default true,
  demo_now timestamptz                            -- only honored when DEMO_MODE
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('paste','upload','quick_add','email_forward')),
  title text,
  text_content text,                              -- null after retention purge
  storage_path text,                              -- null for paste/quick_add
  mime_type text,
  reference_date date not null,
  reference_date_source text not null check (reference_date_source in ('user','detected','defaulted')),
  page_offsets int[],
  created_at timestamptz not null default now()
);
create index sources_user_idx on public.sources (user_id, created_at desc);

create table public.extractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  source_id uuid not null,
  status text not null check (status in ('running','succeeded','failed')),
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  raw_output jsonb,                               -- full model JSON, for debugging/evals
  brief jsonb,                                    -- validated Explain card
  input_tokens int,
  output_tokens int,
  latency_ms int,
  error text,
  created_at timestamptz not null default now()
);
create index extractions_source_idx on public.extractions (source_id);

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  title text not null,
  kind text not null check (kind in ('commitment','request','waiting_on','admin','decision')),
  next_action text,
  counterparty text,
  due_at timestamptz,
  due_certainty text not null default 'none' check (due_certainty in ('explicit','inferred','none')),
  due_time_known boolean not null default false,  -- false: date-only deadline, never render a time
  consequence text,
  consequence_basis text check (consequence_basis in ('source','interpretation')),
  status text not null default 'open'
    check (status in ('open','waiting','snoozed','resolved','dismissed')),
  resolution text check (resolution in ('done','decided','not_needed')),
  waiting_on text,
  expected_by timestamptz,
  snoozed_until timestamptz,
  primary_source_id uuid,
  confidence numeric(3,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index threads_user_status_due_idx on public.threads (user_id, status, due_at);
create index threads_title_trgm_idx on public.threads using gin (title extensions.gin_trgm_ops);

create table public.extraction_items (            -- proposals; "Suggested" lives here (D2)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  extraction_id uuid not null,
  payload jsonb not null,                         -- validated Item from schema v1
  confidence numeric(3,2) not null,
  band text not null check (band in ('high','medium','low','ignore')),
  review_status text not null default 'pending'
    check (review_status in ('pending','accepted','edited','rejected','auto_created')),
  thread_id uuid,
  suppression_hash text,                          -- hash(source text hash + quote) for dismiss/reject
  reviewed_at timestamptz
);
create index extraction_items_extraction_idx on public.extraction_items (extraction_id);
create index extraction_items_suppression_idx on public.extraction_items (user_id, suppression_hash);

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  source_id uuid,                                -- quote survives source deletion
  thread_id uuid,
  extraction_item_id uuid,
  quote text not null,
  start_offset int,
  end_offset int,
  page int,
  match_kind text not null check (match_kind in ('exact','fuzzy')),
  quote_hash text
);
create index evidence_thread_idx on public.evidence (thread_id);
create index evidence_source_idx on public.evidence (source_id);

create table public.thread_events (                -- append-only audit/history
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  thread_id uuid not null,
  actor text not null check (actor in ('user','ai','system')),
  type text not null,   -- created, edited, status_changed, snoozed, source_linked, resolved, reopened, digest_sent, marked_not_useful
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index thread_events_thread_idx on public.thread_events (thread_id, created_at);

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  thread_id uuid not null,
  choice text not null,
  reason_user text,                               -- verbatim, nullable (skipped)
  reason_ai_summary text,                         -- always labeled if shown
  context_facts jsonb not null default '[]',      -- [{text, evidence_id}]
  decided_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('english', coalesce(choice,'') || ' ' || coalesce(reason_user,''))) stored
);
create index decisions_search_idx on public.decisions using gin (search);
create index decisions_thread_idx on public.decisions (thread_id);

-- Cross-user integrity: a child row can only point at rows owned by the same user. RLS checks
-- user_id on the row itself, but plain foreign keys are checked without RLS, so composite
-- (id, user_id) keys stop a user linking their rows to another user's IDs.
-- ON DELETE SET NULL (col) nulls only the reference, never user_id (Postgres 15+).
alter table public.sources          add constraint sources_id_user_key          unique (id, user_id);
alter table public.extractions      add constraint extractions_id_user_key      unique (id, user_id);
alter table public.threads          add constraint threads_id_user_key          unique (id, user_id);
alter table public.extraction_items add constraint extraction_items_id_user_key unique (id, user_id);

alter table public.extractions add constraint extractions_source_fk
  foreign key (source_id, user_id) references public.sources (id, user_id) on delete cascade;
alter table public.threads add constraint threads_primary_source_fk
  foreign key (primary_source_id, user_id) references public.sources (id, user_id) on delete set null (primary_source_id);
alter table public.extraction_items add constraint extraction_items_extraction_fk
  foreign key (extraction_id, user_id) references public.extractions (id, user_id) on delete cascade;
alter table public.extraction_items add constraint extraction_items_thread_fk
  foreign key (thread_id, user_id) references public.threads (id, user_id) on delete set null (thread_id);
alter table public.evidence add constraint evidence_source_fk
  foreign key (source_id, user_id) references public.sources (id, user_id) on delete set null (source_id);
alter table public.evidence add constraint evidence_thread_fk
  foreign key (thread_id, user_id) references public.threads (id, user_id) on delete cascade;
-- SET NULL, not CASCADE: deleting only a source cascades through extractions → extraction_items,
-- and a thread's quote excerpts must survive that (F13 "threads keep their quote excerpts").
-- Evidence still goes when its thread is forgotten (evidence_thread_fk cascades).
alter table public.evidence add constraint evidence_extraction_item_fk
  foreign key (extraction_item_id, user_id) references public.extraction_items (id, user_id) on delete set null (extraction_item_id);
alter table public.thread_events add constraint thread_events_thread_fk
  foreign key (thread_id, user_id) references public.threads (id, user_id) on delete cascade;
alter table public.decisions add constraint decisions_thread_fk
  foreign key (thread_id, user_id) references public.threads (id, user_id) on delete cascade;

-- Rate limiting (PRD Technical Architecture: "Postgres counter table per user per day").
create table public.usage_counters (
  user_id uuid not null references public.profiles on delete cascade,
  day date not null,                              -- UTC day (see consume_usage)
  extractions int not null default 0,
  asks int not null default 0,
  primary key (user_id, day)
);

-- profiles.timezone must be a real IANA zone: it drives every local-date computation.
create function public.profiles_check_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger profiles_check_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.profiles_check_timezone();

-- History is never rewritten: thread_events rows cannot be updated.
-- (Rows still disappear through ON DELETE CASCADE when a thread is forgotten, per rule 8.)
create function public.thread_events_no_update() returns trigger
language plpgsql as $$
begin
  raise exception 'thread_events is append-only';
end;
$$;
create trigger thread_events_no_update
  before update on public.thread_events
  for each row execute function public.thread_events_no_update();

-- threads.updated_at maintenance. The app also sets it from getNow(); this keeps it honest.
create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger threads_touch_updated_at
  before update on public.threads
  for each row execute function public.touch_updated_at();

-- F1: first sign-in creates profiles and user_settings rows. Timezone is set later from the browser.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, aliases)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1), ''),
    case when new.email is null then '{}'::text[] else array[new.email] end
  );
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
