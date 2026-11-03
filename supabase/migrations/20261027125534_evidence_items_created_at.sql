-- S10 follow-up (F8 Why panel, tester finding on test/s9b-s10-verify): the Why panel and Thread
-- detail pick "the first" evidence quote and "the" proposal of a thread. Ordering by a uuid id, or
-- not ordering at all, could show a different quote on another load. Additive: a creation time on
-- both tables so readers order by (created_at, id). Rows that predate this get the migration's time
-- and fall back to the id tie-break, which is still the same on every load.
alter table public.evidence add column created_at timestamptz not null default now();
alter table public.extraction_items add column created_at timestamptz not null default now();
