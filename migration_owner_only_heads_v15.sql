-- info cc 404 — owner-only management of section heads
-- Safe to apply repeatedly. Does not delete users or alter existing assignments.
begin;

create or replace function public.admin_list_users_for_heads()
returns table(id uuid, email text, role text, group_no smallint)
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $function$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may view accounts for section-head management.';
  end if;

  return query
  select u.id, u.email::text,
    case
      when lower(coalesce(u.email, '')) = 'locoviber16@gmail.com' then 'owner'
      when a.user_id is not null then 'admin'
      when up.user_id is not null then 'uploader'
      else 'student'
    end::text,
    coalesce(up.group_no, sp.group_no)
  from auth.users u
  left join public.admins a on a.user_id = u.id
  left join public.uploaders up on up.user_id = u.id
  left join public.student_profiles sp on sp.user_id = u.id
  order by u.created_at desc;
end;
$function$;

create or replace function public.owner_set_uploader(p_user uuid, p_group smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $function$
declare
  v_target_email text;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may appoint group heads.';
  end if;
  if p_group is null or p_group < 1 or p_group > 10 then
    raise exception 'Group number must be between 1 and 10.';
  end if;

  select lower(email) into v_target_email from auth.users where id = p_user;
  if not found then raise exception 'User not found.'; end if;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'The owner role cannot be changed.';
  end if;

  delete from public.admins where user_id = p_user;
  insert into public.uploaders(user_id, group_no)
  values (p_user, p_group)
  on conflict (user_id) do update set group_no = excluded.group_no, created_at = now();
end;
$function$;

create or replace function public.owner_remove_uploader(p_user uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $function$
declare
  v_target_email text;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may remove group heads.';
  end if;

  select lower(email) into v_target_email from auth.users where id = p_user;
  if not found then raise exception 'User not found.'; end if;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'The owner role cannot be changed.';
  end if;

  delete from public.uploaders where user_id = p_user;
end;
$function$;

notify pgrst, 'reload schema';
commit;
