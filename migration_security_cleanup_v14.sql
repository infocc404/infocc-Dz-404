-- info cc 404 — security cleanup and PostgREST refresh
-- Review before applying. This migration preserves all application data.
begin;

-- The activity log is private to the platform owner; remove the older policy
-- that also allowed general admins to read it.
drop policy if exists "Owner and admins read activity log" on public.admin_activity_log;

-- These helpers are intended for signed-in app sessions or internal triggers,
-- not anonymous RPC calls. Keep authenticated grants where app/RLS requires them.
revoke execute on function public.can_upload() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.my_group_no() from public, anon;
revoke execute on function public.my_role() from public, anon;
revoke execute on function public.uploader_group() from public, anon;

-- This function is called by the auth.users trigger, not by browser RPC.
revoke execute on function public.create_student_profile() from public, anon, authenticated;

-- Remove the legacy announcement trigger that writes to the unused notifications table.
-- Existing historical notifications are preserved; the app reads user_notifications.
drop trigger if exists info_cc_announcement_notify_insert on public.announcements;

-- Correct the Arabic text in the active notification trigger. The app reads this table.
create or replace function public.notify_announcement_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $function$
begin
  insert into public.user_notifications(user_id, title, body, kind, link)
  select u.id,
         case
           when coalesce(new.priority, 'normal') = 'urgent' then 'إعلان عاجل جديد'
           when coalesce(new.priority, 'normal') = 'important' then 'إعلان مهم جديد'
           else 'إعلان جديد'
         end,
         coalesce(new.title, 'إعلان') ||
           case when coalesce(new.body, '') = '' then '' else E'\\n' || left(new.body, 500) end,
         'announcement',
         '#/announcements'
  from auth.users u
  where not exists (
    select 1
    from public.notification_preferences p
    where p.user_id = u.id and p.announcements_enabled = false
  );
  return new;
end;
$function$;

-- Keep the account activity check callable because the current file RLS policy
-- includes anon in its role target; it returns false for unauthenticated sessions.
-- Do not weaken the existing owner checks on owner_remove_admin / owner_set_user_suspended.
revoke all on function public.owner_remove_admin(uuid) from public, anon;
grant execute on function public.owner_remove_admin(uuid) to authenticated;
revoke all on function public.owner_set_user_suspended(uuid, boolean) from public, anon;
grant execute on function public.owner_set_user_suspended(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
