-- info cc 404 — consolidate overlapping RLS policies and enforce owner-only account-role writes
-- Safe to re-run. Existing rows are preserved.
begin;

-- Account deletion requests: students may create/read their own requests;
-- only the owner may read all requests, update status, or delete requests.
drop policy if exists "owner manages deletion requests" on public.account_deletion_requests;
drop policy if exists "students read own deletion requests" on public.account_deletion_requests;
create policy "owner or student reads deletion requests"
on public.account_deletion_requests for select to authenticated
using (
  public.current_role() = 'owner'
  or user_id = (select auth.uid())
);
create policy "owner updates deletion requests"
on public.account_deletion_requests for update to authenticated
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');
create policy "owner deletes deletion requests"
on public.account_deletion_requests for delete to authenticated
using (public.current_role() = 'owner');

-- Group-change requests: one SELECT policy for the request owner and authorized reviewers.
drop policy if exists "gcr_admin_select" on public.group_change_requests;
drop policy if exists "gcr_select_own" on public.group_change_requests;
create policy "students and staff read group requests"
on public.group_change_requests for select to authenticated
using (
  public.current_role() = any (array['owner'::text, 'admin'::text])
  or user_id = (select auth.uid())
);

-- The ALL policy already includes SELECT for the user's own preferences.
drop policy if exists "Users read own notification preferences" on public.notification_preferences;

-- Student profile reads remain self/owner and assigned-group uploader only.
-- Mutations are owner-only, without an overlapping ALL/SELECT policy.
drop policy if exists "student_profiles managed by owner only" on public.student_profiles;
create policy "owner inserts student profiles"
on public.student_profiles for insert to authenticated
with check (public.is_account_active() and public.current_role() = 'owner');
create policy "owner updates student profiles"
on public.student_profiles for update to authenticated
using (public.is_account_active() and public.current_role() = 'owner')
with check (public.is_account_active() and public.current_role() = 'owner');
create policy "owner deletes student profiles"
on public.student_profiles for delete to authenticated
using (public.is_account_active() and public.current_role() = 'owner');

-- Combine self/owner reads and assigned-group uploader reads into one policy.
drop policy if exists "students read own profile or owner" on public.student_profiles;
drop policy if exists "uploaders read students in assigned group" on public.student_profiles;
create policy "authorized student profile reads"
on public.student_profiles for select to authenticated
using (
  public.is_account_active()
  and (
    user_id = (select auth.uid())
    or public.current_role() = 'owner'
    or (
      public.current_role() = 'uploader'
      and exists (
        select 1
        from public.uploaders up
        where up.user_id = (select auth.uid())
          and up.group_no = student_profiles.group_no
      )
    )
  )
);

-- Section-head role assignments are owner-managed, not admin-managed.
drop policy if exists "uploaders managed by owner or admin" on public.uploaders;
drop policy if exists "uploaders read own or owner" on public.uploaders;
create policy "owner inserts uploaders"
on public.uploaders for insert to authenticated
with check (public.is_account_active() and public.current_role() = 'owner');
create policy "owner updates uploaders"
on public.uploaders for update to authenticated
using (public.is_account_active() and public.current_role() = 'owner')
with check (public.is_account_active() and public.current_role() = 'owner');
create policy "owner deletes uploaders"
on public.uploaders for delete to authenticated
using (public.is_account_active() and public.current_role() = 'owner');

-- A single SELECT policy preserves both own-report visibility and staff review.
drop policy if exists "Admins read support reports" on public.support_reports;
drop policy if exists "Users read own support reports" on public.support_reports;
create policy "users and staff read support reports"
on public.support_reports for select to authenticated
using (
  user_id = (select auth.uid())
  or public.current_role() = any (array['owner'::text, 'admin'::text])
);

notify pgrst, 'reload schema';
commit;
