-- info cc 404 — Security and role-separation fixes (v10)
-- Apply only after reviewing this file in Supabase SQL Editor.
-- This migration is additive to existing user/file records; it does not delete files or users.

begin;

-- Account status is checked in the database as well as by Supabase Auth.
create or replace function public.is_account_active()
returns boolean
language sql
security definer
set search_path = pg_catalog, public, auth, pg_temp
stable
as $$
  select auth.uid() is not null
     and not exists (
       select 1 from auth.users u
       where u.id = auth.uid()
         and u.banned_until is not null
         and u.banned_until > now()
     );
$$;

create or replace function public.current_role()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_banned_until timestamptz;
begin
  if v_uid is null then return 'anon'; end if;
  select u.email, u.banned_until into v_email, v_banned_until
  from auth.users u where u.id = v_uid;
  if v_banned_until is not null and v_banned_until > now() then return 'suspended'; end if;
  if lower(coalesce(v_email, '')) = 'locoviber16@gmail.com' then return 'owner'; end if;
  if exists (select 1 from public.admins a where a.user_id = v_uid) then return 'admin'; end if;
  if exists (select 1 from public.uploaders up where up.user_id = v_uid) then return 'uploader'; end if;
  return 'student';
end;
$$;

create or replace function public.my_group_no()
returns smallint
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_group smallint;
begin
  if v_uid is null or not public.is_account_active() then return null; end if;
  select up.group_no into v_group from public.uploaders up where up.user_id = v_uid;
  if v_group is not null then return v_group; end if;
  select sp.group_no into v_group from public.student_profiles sp where sp.user_id = v_uid;
  return v_group;
end;
$$;

create or replace function public.my_role()
returns table (user_role text, uploader_group smallint, assigned_group smallint)
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_uploader_group smallint;
  v_assigned_group smallint;
begin
  if v_uid is null then
    return query select 'anon'::text, null::smallint, null::smallint;
    return;
  end if;
  v_role := public.current_role();
  if v_role = 'suspended' then
    return query select 'suspended'::text, null::smallint, null::smallint;
    return;
  end if;
  select up.group_no into v_uploader_group from public.uploaders up where up.user_id = v_uid;
  v_assigned_group := public.my_group_no();
  return query select v_role, v_uploader_group, v_assigned_group;
end;
$$;

revoke all on function public.is_account_active() from public, anon;
grant execute on function public.is_account_active() to authenticated, anon;

-- The owner-only user directory returns a stable schema for the current frontend.
drop function if exists public.owner_list_users();
create function public.owner_list_users()
returns table (
  id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  role text,
  group_no smallint,
  is_suspended boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may view the complete user directory.';
  end if;

  return query
  select
    u.id,
    u.email::text,
    u.created_at,
    u.last_sign_in_at,
    case
      when lower(coalesce(u.email, '')) = 'locoviber16@gmail.com' then 'owner'
      when a.user_id is not null then 'admin'
      when up.user_id is not null then 'uploader'
      else 'student'
    end::text as role,
    coalesce(up.group_no, sp.group_no) as group_no,
    coalesce(u.banned_until > now(), false) as is_suspended
  from auth.users u
  left join public.admins a on a.user_id = u.id
  left join public.uploaders up on up.user_id = u.id
  left join public.student_profiles sp on sp.user_id = u.id
  order by u.created_at desc;
end;
$$;

revoke all on function public.owner_list_users() from public, anon;
grant execute on function public.owner_list_users() to authenticated;

-- A separate, limited directory for owner/admin head assignment. The full owner
-- dashboard remains protected by owner_list_users() above.
drop function if exists public.admin_list_users_for_heads();
create function public.admin_list_users_for_heads()
returns table (id uuid, email text, role text, group_no smallint)
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
begin
  if auth.uid() is null or public.current_role() not in ('owner', 'admin') then
    raise exception 'Only the owner or an authorized admin may manage group heads.';
  end if;
  return query
  select u.id, u.email::text,
    case
      when lower(coalesce(u.email, '')) = 'locoviber16@gmail.com' then 'owner'
      when a.user_id is not null then 'admin'
      when up.user_id is not null then 'uploader'
      else 'student'
    end::text as role,
    coalesce(up.group_no, sp.group_no) as group_no
  from auth.users u
  left join public.admins a on a.user_id = u.id
  left join public.uploaders up on up.user_id = u.id
  left join public.student_profiles sp on sp.user_id = u.id
  order by u.created_at desc;
end;
$$;
revoke all on function public.admin_list_users_for_heads() from public, anon;
grant execute on function public.admin_list_users_for_heads() to authenticated;

-- Owner and admins may appoint/remove group heads; admins may not promote or demote admins.
create or replace function public.owner_set_uploader(p_user uuid, p_group smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_target_email text;
begin
  if auth.uid() is null or public.current_role() not in ('owner', 'admin') then
    raise exception 'Only the owner or an authorized admin may appoint group heads.';
  end if;
  if p_group is null or p_group < 1 or p_group > 10 then
    raise exception 'Group number must be between 1 and 10.';
  end if;

  select lower(email) into v_target_email from auth.users where id = p_user;
  if not found then raise exception 'User not found.'; end if;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'The owner role cannot be changed.';
  end if;
  if public.current_role() = 'admin' and exists (select 1 from public.admins a where a.user_id = p_user) then
    raise exception 'Admins cannot change the role of another admin.';
  end if;

  delete from public.admins where user_id = p_user;
  insert into public.uploaders(user_id, group_no)
  values (p_user, p_group)
  on conflict (user_id) do update set group_no = excluded.group_no, created_at = now();
end;
$$;

create or replace function public.owner_remove_uploader(p_user uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_target_email text;
begin
  if auth.uid() is null or public.current_role() not in ('owner', 'admin') then
    raise exception 'Only the owner or an authorized admin may remove group heads.';
  end if;
  select lower(email) into v_target_email from auth.users where id = p_user;
  if not found then raise exception 'User not found.'; end if;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'The owner role cannot be changed.';
  end if;
  if public.current_role() = 'admin' and exists (select 1 from public.admins a where a.user_id = p_user) then
    raise exception 'Admins cannot change the role of another admin.';
  end if;
  delete from public.uploaders where user_id = p_user;
end;
$$;

-- Keep direct student group assignment owner-only. Admins can still review
-- submitted requests through review_group_change_request().
create or replace function public.admin_set_student_group(p_user uuid, p_group smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_target_email text;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may directly assign student groups.';
  end if;
  if p_group is null or p_group < 1 or p_group > 10 then
    raise exception 'Group number must be between 1 and 10.';
  end if;
  select lower(email) into v_target_email from auth.users where id = p_user;
  if not found then raise exception 'User not found.'; end if;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'The owner does not have a student group.';
  end if;
  insert into public.student_profiles(user_id, group_no)
  values (p_user, p_group)
  on conflict (user_id) do update set group_no = excluded.group_no, created_at = now();
end;
$$;

drop policy if exists "uploaders read authorized" on public.uploaders;
create policy "uploaders read self or owner" on public.uploaders
  for select to authenticated
  using (public.is_account_active() and (user_id = auth.uid() or public.current_role() = 'owner'));

drop policy if exists "uploaders managed by admin or owner" on public.uploaders;
drop policy if exists "uploaders managed by owner or admin" on public.uploaders;
create policy "uploaders managed by owner or admin" on public.uploaders
  for all to authenticated
  using (public.is_account_active() and public.current_role() in ('owner', 'admin'))
  with check (public.is_account_active() and public.current_role() in ('owner', 'admin'));

drop policy if exists "students read own profile" on public.student_profiles;
create policy "students read own profile or owner" on public.student_profiles
  for select to authenticated
  using (public.is_account_active() and (user_id = auth.uid() or public.current_role() = 'owner'));

drop policy if exists "student_profiles managed by admin or owner" on public.student_profiles;
create policy "student_profiles managed by owner only" on public.student_profiles
  for all to authenticated
  using (public.is_account_active() and public.current_role() = 'owner')
  with check (public.is_account_active() and public.current_role() = 'owner');

drop policy if exists "admins read all or own" on public.admins;
create policy "admins read self or owner" on public.admins
  for select to authenticated
  using (public.is_account_active() and (user_id = auth.uid() or public.current_role() = 'owner'));

-- Correct file visibility: a NULL group is not automatically global.
-- Shared files use common/; group-specific legacy rows can be resolved from gN/ paths.
drop policy if exists "authorized read files" on public.files;
create policy "authorized read files" on public.files
  for select to public
  using (
    public.is_account_active()
    and (
      public.current_role() in ('owner', 'admin')
      or path like 'common/%'
    or (
      public.my_group_no() is not null
      and (
        group_no = public.my_group_no()
        or path like 'g' || public.my_group_no() || '/%'
      )
    )
    or (
      kind = 'cours'
      and group_no is null
      and path !~ '^g(10|[1-9])/'
      )
    )
  );

-- Correct storage visibility using the object path. Do not grant access merely
-- because a related database row happens to have group_no NULL.
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
          and (
            (f.group_no is not null and public.my_group_no() is not null
              and f.group_no = public.my_group_no())
            or (f.kind = 'cours' and f.group_no is null
              and f.path !~ '^g(10|[1-9])/')
          )
      )
    )
  );

revoke all on function public.admin_list_users_for_heads() from public, anon;
revoke all on function public.owner_set_uploader(uuid, smallint) from public, anon;
revoke all on function public.owner_remove_uploader(uuid) from public, anon;
revoke all on function public.admin_set_student_group(uuid, smallint) from public, anon;
grant execute on function public.admin_list_users_for_heads() to authenticated;
grant execute on function public.owner_set_uploader(uuid, smallint) to authenticated;
grant execute on function public.owner_remove_uploader(uuid) to authenticated;
grant execute on function public.admin_set_student_group(uuid, smallint) to authenticated;

commit;

-- Refresh the PostgREST schema cache after applying:
-- notify pgrst, 'reload schema';
