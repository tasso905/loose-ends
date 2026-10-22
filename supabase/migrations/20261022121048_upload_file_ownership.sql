-- fix/upload-hardening (rule 8, data integrity): a user may delete a file in their own folder only
-- while no `sources` row owns it. A replayed submit, or the browser cleaning up after a failed
-- submit, can then never remove the file behind an existing source. Deleting a source goes row
-- first (forget_thread returns the storage_path after deleting the row), so it is unaffected;
-- account deletion uses the service role and bypasses this policy.
alter policy sources_bucket_delete_own on storage.objects
  using (
    bucket_id = 'sources'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (
      select 1 from public.sources s
      where s.user_id = (select auth.uid()) and s.storage_path = storage.objects.name
    )
  );
