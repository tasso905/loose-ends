-- F1: the onboarding aliases question is shown once (SITE_CONTRACT §1.2). Additive only.
-- Null = onboarding not answered or skipped yet; /auth/callback sends the user to /onboarding.
-- Users that already exist are marked onboarded so the question only appears for new sign-ups.
alter table public.profiles add column onboarded_at timestamptz;

update public.profiles set onboarded_at = created_at where onboarded_at is null;
