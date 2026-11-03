-- Global daily AI spend cap, DAILY_AI_BUDGET_USD (PRD Technical Architecture "Rate limiting";
-- D62 keeps it). Additive: one private table, two usage_counters columns, one index, two functions.
--
-- Every model call goes through a budget check before it is made and records its estimated cost
-- after it returns (lib/ai/budget.ts). The cap itself lives in the server's environment, so the
-- check takes it as an argument; the spend lives here.
--
-- Spend is kept in two places:
--   * private.ai_spend_daily (no user id): the global total per UTC day that the cap is checked
--     against. Not per user, so deleting an account (rule 8) cannot give the day's spend back.
--   * usage_counters.ai_calls / ai_cost_micros: the caller's own share, used only to bound what a
--     caller can record. Both functions are callable by any signed-in user (the app calls them
--     with the user-scoped client, like consume_usage), so a caller could call record_ai_cost
--     directly. A call may record at most private.ai_max_call_cost_micros(), and only while the
--     caller's recorded calls stay under what their own counted usage allows (each counted
--     extraction: 4 attempts x 2 model calls; each counted ask: 2 model calls). A forged record
--     can therefore add no more than that user's own daily limits could have cost. It can never
--     lower the total (costs are >= 0, and nothing here subtracts).

create table private.ai_spend_daily (
  day date primary key,                         -- UTC day
  cost_micros bigint not null default 0 check (cost_micros >= 0),  -- US dollars x 1,000,000
  calls int not null default 0 check (calls >= 0)
);
revoke all on private.ai_spend_daily from public, anon, authenticated;

alter table public.usage_counters
  add column ai_calls int not null default 0,
  add column ai_cost_micros bigint not null default 0;

create index usage_counters_day on public.usage_counters (day);

-- The most one model call may record: $0.20. A real call costs far less (lib/ai/budget.ts prices
-- the largest input and output at a few cents); the clamp only bounds a forged record.
create function private.ai_max_call_cost_micros() returns bigint
language sql immutable set search_path = '' as $$ select 200000::bigint $$;
revoke all on function private.ai_max_call_cost_micros() from public, anon, authenticated;

-- True while today's (UTC) recorded spend is below the cap. Callers treat an error as closed.
create function public.ai_budget_open(p_budget_micros bigint) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_budget_micros is null or p_budget_micros < 0 then
    raise exception using errcode = '22023', message = 'invalid budget';
  end if;
  return coalesce(
    (select s.cost_micros from private.ai_spend_daily s where s.day = (now() at time zone 'UTC')::date),
    0
  ) < p_budget_micros;
end;
$$;
revoke all on function public.ai_budget_open(bigint) from public, anon;
grant execute on function public.ai_budget_open(bigint) to authenticated;

-- Records one model call's estimated cost for today (UTC). Returns false, recording nothing, when
-- the caller has already recorded as many calls as their counted usage allows.
create function public.record_ai_cost(p_cost_micros bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'UTC')::date;
  v_cost bigint;
  v_ok boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_cost_micros is null or p_cost_micros < 0 then
    raise exception using errcode = '22023', message = 'invalid cost';
  end if;
  v_cost := least(p_cost_micros, private.ai_max_call_cost_micros());

  update public.usage_counters
    set ai_calls = ai_calls + 1, ai_cost_micros = ai_cost_micros + v_cost
    where user_id = v_uid and day = v_day and ai_calls < extractions * 8 + asks * 2
    returning true into v_ok;
  if v_ok is null then
    return false;
  end if;

  insert into private.ai_spend_daily as s (day, cost_micros, calls) values (v_day, v_cost, 1)
  on conflict (day) do update set cost_micros = s.cost_micros + excluded.cost_micros, calls = s.calls + 1;
  return true;
end;
$$;
revoke all on function public.record_ai_cost(bigint) from public, anon;
grant execute on function public.record_ai_cost(bigint) to authenticated;
