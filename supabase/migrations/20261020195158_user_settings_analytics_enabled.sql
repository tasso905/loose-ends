-- D40: product analytics is opt-out, events only, no content. The Settings → Profile toggle writes
-- this column; track() sends nothing for a user whose value is false. Additive only.
--
-- RLS: user_settings already has row-level security with user_settings_select_own and
-- user_settings_update_own (user_id = auth.uid()), which cover every column, this one included.
-- There is no insert or delete policy: the sign-up trigger creates the row, so existing and new
-- users both get the default.
alter table public.user_settings add column analytics_enabled boolean not null default true;
