-- info cc 404 — v11: strict per-group file isolation
-- Safe follow-up to v10. Root-level files with NULL group_no are intentionally NOT
-- assigned to a group automatically because their real group cannot be inferred safely.
begin;

-- Backfill only when the storage path itself explicitly identifies a group.
update public.files
set group_no = (substring(path from '^g(10|[1-9])/'))::smallint
where group_no is null
  and path ~ '^g(10|[1-9])/';

-- Recreate file metadata read policy: only explicit shared/common files or own-group files.
drop policy if exists "authorized read files" on public.files;
create policy "authorized read files" on public.files
for select to public
using (
  public.is_account_active()
  and (
    public.current_role() in ('owner', 'admin')
    or (group_no is null and path like 'common/%')
    or (
      public.my_group_no() is not null
      and (
        group_no = public.my_group_no()
        or path like 'g' || public.my_group_no() || '/%'
      )
    )
  )
);

-- Recreate storage read policy without the old exception that exposed every ungrouped
-- 'cours' record to all groups.
drop policy if exists "authorized read storage" on storage.objects;
create policy "authorized read storage" on storage.objects
for select to public
using (
  public.is_account_active()
  and bucket_id = 'course-files'
  and (
    public.current_role() in ('owner', 'admin')
    or name like 'common/%'
    or (
      public.my_group_no() is not null
      and name like 'g' || public.my_group_no() || '/%'
    )
    or exists (
      select 1 from public.files f
      where f.path = storage.objects.name
        and f.group_no is not null
        and public.my_group_no() is not null
        and f.group_no = public.my_group_no()
    )
  )
);

-- Prevent unauthenticated calls; authenticated users still get role-checked in each function.
revoke all on function public.admin_list_users_for_heads() from public, anon;
revoke all on function public.owner_set_uploader(uuid, smallint) from public, anon;
revoke all on function public.owner_remove_uploader(uuid) from public, anon;
revoke all on function public.admin_set_student_group(uuid, smallint) from public, anon;
grant execute on function public.admin_list_users_for_heads() to authenticated;
grant execute on function public.owner_set_uploader(uuid, smallint) to authenticated;
grant execute on function public.owner_remove_uploader(uuid) to authenticated;
grant execute on function public.admin_set_student_group(uuid, smallint) to authenticated;

commit;
notify pgrst, 'reload schema';

-- Diagnostic query for ambiguous legacy files. Review and manually assign their true group:
-- select id, title, kind, group_no, path from public.files
-- where group_no is null and path not like 'common/%' and path !~ '^g(10|[1-9])/';
