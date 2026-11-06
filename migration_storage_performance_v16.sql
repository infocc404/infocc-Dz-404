-- info cc 404 — storage access and query-performance improvements
-- Safe: adds indexes and rewrites equivalent RLS auth calls; no user data is changed.
begin;

-- The website requires authentication before file access.
drop policy if exists "authorized read storage" on storage.objects;
create policy "authorized read storage"
on storage.objects
for select
to authenticated
using (
  public.is_account_active()
  and bucket_id = 'course-files'
  and (
    public.current_role() = any (array['owner'::text, 'admin'::text])
    or name like 'common/%'
    or (
      public.my_group_no() is not null
      and (
        name like ('g' || public.my_group_no() || '/%')
        or exists (
          select 1
          from public.files f
          where f.path = objects.name
            and f.group_no is not null
            and public.my_group_no() is not null
            and f.group_no = public.my_group_no()
        )
      )
    )
  )
);

-- Cover foreign-key lookups identified by the Supabase performance advisor.
create index if not exists account_deletion_requests_reviewed_by_idx on public.account_deletion_requests(reviewed_by);
create index if not exists admin_activity_log_actor_user_id_idx on public.admin_activity_log(actor_user_id);
create index if not exists announcements_created_by_idx on public.announcements(created_by);
create index if not exists files_uploaded_by_idx on public.files(uploaded_by);
create index if not exists group_change_requests_reviewed_by_idx on public.group_change_requests(reviewed_by);
create index if not exists student_conversations_created_by_idx on public.student_conversations(created_by);
create index if not exists student_favorites_file_id_idx on public.student_favorites(file_id);
create index if not exists student_messages_sender_id_idx on public.student_messages(sender_id);

-- Cache auth.uid()/auth.jwt() once per statement instead of per row.
-- The policy's role, command, permissive/restrictive mode, and predicates are preserved.
do $block$
declare
  p record;
  v_qual text;
  v_check text;
  v_sql text;
begin
  for p in
    select *
    from pg_policies
    where schemaname in ('public', 'storage')
      and (
        coalesce(qual, '') ~* 'auth\.(uid|jwt)\s*\('
        or coalesce(with_check, '') ~* 'auth\.(uid|jwt)\s*\('
      )
      and not (
        coalesce(qual, '') ~* '\(\s*select\s+\(*\s*auth\.(uid|jwt)'
        or coalesce(with_check, '') ~* '\(\s*select\s+\(*\s*auth\.(uid|jwt)'
      )
  loop
    v_qual := case when p.qual is null then null else
      regexp_replace(
        regexp_replace(p.qual, 'auth\.uid\s*\(\)', '(select auth.uid())', 'gi'),
        'auth\.jwt\s*\(\)', '(select auth.jwt())', 'gi'
      ) end;
    v_check := case when p.with_check is null then null else
      regexp_replace(
        regexp_replace(p.with_check, 'auth\.uid\s*\(\)', '(select auth.uid())', 'gi'),
        'auth\.jwt\s*\(\)', '(select auth.jwt())', 'gi'
      ) end;

    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    v_sql := format(
      'create policy %I on %I.%I as %s for %s to %s',
      p.policyname, p.schemaname, p.tablename, p.permissive, p.cmd,
      array_to_string(p.roles, ', ')
    );
    if v_qual is not null then
      v_sql := v_sql || format(' using (%s)', v_qual);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;
    execute v_sql;
  end loop;
end;
$block$;

notify pgrst, 'reload schema';
commit;
