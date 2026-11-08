-- Global daily AI spend cap, DAILY_AI_BUDGET_USD (PRD Technical Architecture "Rate limiting";
-- D62 keeps it). Additive: one private table, two functions.
--
-- Every model call goes through a budget check before it is made and records its estimated cost
-- after it returns (lib/ai/budget.ts). The cap itself lives in the server's environment, so the
-- check takes it as an argument; the spend lives here.
--
-- Both functions are callable by the service role only, and the app calls them through a client
-- that can call nothing else (lib/ai/budgetDb.ts; approved by the user Nov 4). A signed-in user
-- cannot read the day's spend, forge a record to close the budget for everyone, or hide their own
-- calls.
--
-- private.ai_spend_daily has no user id: deleting an account (rule 8) cannot give the day's spend
-- back, and spend is recorded against the UTC day the call returned on, so a call that spans
-- midnight is never lost.

create table private.ai_spend_daily (
  day date primary key,                         -- UTC day
  cost_micros bigint not null default 0 check (cost_micros >= 0),  -- US dollars x 1,000,000
  calls int not null default 0 check (calls >= 0)
);
revoke all on private.ai_spend_daily from public, anon, authenticated;

-- True while today's (UTC) recorded spend is below the cap. Callers treat an error as closed.
-- Definer: the service role has no privileges on the private table.
create function public.ai_budget_open(p_budget_micros bigint) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_budget_micros is null or p_budget_micros < 0 then
    raise exception using errcode = '22023', message = 'invalid budget';
  end if;
  return coalesce(
    (select s.cost_micros from private.ai_spend_daily s where s.day = (now() at time zone 'UTC')::date),
    0
  ) < p_budget_micros;
end;
$$;
revoke all on function public.ai_budget_open(bigint) from public, anon, authenticated;
grant execute on function public.ai_budget_open(bigint) to service_role;

-- Records one model call's estimated cost for today (UTC).
create function public.record_ai_cost(p_cost_micros bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_cost_micros is null or p_cost_micros < 0 then
    raise exception using errcode = '22023', message = 'invalid cost';
  end if;

  insert into private.ai_spend_daily as s (day, cost_micros, calls)
  values ((now() at time zone 'UTC')::date, p_cost_micros, 1)
  on conflict (day) do update set cost_micros = s.cost_micros + excluded.cost_micros, calls = s.calls + 1;
  return true;
end;
$$;
revoke all on function public.record_ai_cost(bigint) from public, anon, authenticated;
grant execute on function public.record_ai_cost(bigint) to service_role;
