-- info cc 404: repair student group assignments for existing signups
-- Run once in Supabase SQL Editor. This does not change roles or overwrite an existing assigned group.

begin;

-- Ensure the profile table has the expected constraints/shape if it already exists.
create table if not exists public.student_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_no smallint not null check (group_no between 1 and 10),
  created_at timestamptz not null default now()
);

-- Backfill only users whose trusted signup metadata contains a valid group and who have no profile yet.
insert into public.student_profiles (user_id, group_no)
select u.id, (u.raw_user_meta_data ->> 'group_no')::smallint
from auth.users u
where coalesce(u.raw_user_meta_data ->> 'group_no', '') ~ '^(10|[1-9])$'
on conflict (user_id) do nothing;

-- Keep future signups' chosen group in the authoritative table used by RLS.
create or replace function public.handle_user_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_group smallint;
begin
  if coalesce(new.raw_user_meta_data ->> 'group_no', '') ~ '^(10|[1-9])$' then
    v_group := (new.raw_user_meta_data ->> 'group_no')::smallint;
    insert into public.student_profiles (user_id, group_no)
    values (new.id, v_group)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_user_signup();

commit;

-- Check results:
-- select u.email, sp.group_no, u.raw_user_meta_data ->> 'group_no' as signup_group
-- from auth.users u left join public.student_profiles sp on sp.user_id = u.id
-- order by u.created_at desc;
