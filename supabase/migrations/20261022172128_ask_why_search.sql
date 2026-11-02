-- S9: F12 Ask why retrieval (PRD F12, "Decision Memory" retrieval step 1, D31).
--
-- public.search_decisions(p_question) returns the caller's top 5 decisions for a question, as a
-- jsonb array of the records askWhy() receives (lib/ai/askWhy.ts RetrievedDecision).
--
-- * Full-text over choice + reason (decisions.search) joined with the thread's title and
--   counterparty (D31). English configuration, the same as decisions.search.
-- * The question's lexemes are OR'd, not AND'd: question words such as "choose", "pick", "get" or
--   "go" are rarely in the stored text, and plainto_tsquery's AND found only 5 of the 10 answerable
--   questions in the Ask-why eval set (evals/ask-why/README.md). Ranking (ts_rank) puts the record
--   that shares the most lexemes first. A question with no lexeme in any record returns [] and the
--   caller answers "I don't have a recorded decision about that." without a model call (rule 7).
-- * Lexemes come from to_tsvector and are cast to tsquery as quoted literals, so they are not
--   stemmed twice. A lexeme containing a quote or backslash is skipped rather than escaped.
-- * SECURITY INVOKER: RLS (decisions_select_own, threads own rows) applies, and the explicit
--   user_id = auth.uid() filter repeats it. Read-only; it writes nothing.
-- * The question is capped at 300 characters here as well as in the app (SITE_CONTRACT §2.11).

create function public.search_decisions(p_question text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select (
      select string_agg('''' || l || '''', ' | ')
      from unnest(tsvector_to_array(to_tsvector('english'::regconfig, left(coalesce(p_question, ''), 300)))) as l
      where l !~ '[''\\]'
    ) as text
  ),
  tq as (
    select q.text::tsquery as query from q where q.text is not null
  ),
  hits as (
    select d.id, d.thread_id, t.title as thread_title, t.counterparty, d.choice, d.reason_user,
           d.decided_at, d.context_facts,
           ts_rank(x.doc, tq.query) as rank
    from public.decisions d
    join public.threads t on t.id = d.thread_id and t.user_id = d.user_id
    cross join tq
    cross join lateral (
      select d.search || to_tsvector('english'::regconfig, t.title || ' ' || coalesce(t.counterparty, '')) as doc
    ) x
    where d.user_id = auth.uid()
      and x.doc @@ tq.query
    order by rank desc, d.decided_at desc, d.id
    limit 5
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', h.id,
        'thread_id', h.thread_id,
        'thread_title', h.thread_title,
        'counterparty', h.counterparty,
        'choice', h.choice,
        'reason_user', h.reason_user,
        'decided_at', h.decided_at,
        'context_facts', h.context_facts
      )
      order by h.rank desc, h.decided_at desc, h.id
    ),
    '[]'::jsonb
  )
  from hits h;
$$;

revoke all on function public.search_decisions(text) from public, anon;
grant execute on function public.search_decisions(text) to authenticated;
