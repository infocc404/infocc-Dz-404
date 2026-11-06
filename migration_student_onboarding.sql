-- info cc 404: complete student onboarding after email confirmation
-- Safe additive migration: preserves existing users, roles, files and group RLS.
begin;

alter table public.student_profiles
  add column if not exists display_name text;

alter table public.student_profiles
  drop constraint if exists student_profiles_display_name_length;

alter table public.student_profiles
  add constraint student_profiles_display_name_length
  check (display_name is null or char_length(btrim(display_name)) between 2 and 40);

create or replace function public.complete_student_profile(
  p_display_name text,
  p_group_no smallint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_group smallint;
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولا';
  end if;

  if public.current_role() <> 'student' then
    raise exception 'هذه العملية مخصصة لحسابات الطلبة فقط';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'اسم المستخدم يجب أن يكون بين حرفين و40 حرفا';
  end if;

  if p_group_no is null or p_group_no < 1 or p_group_no > 10 then
    raise exception 'الفوج غير صالح';
  end if;

  select group_no
    into v_existing_group
  from public.student_profiles
  where user_id = v_uid
  for update;

  if found then
    -- Existing group assignments are immutable through this public onboarding RPC.
    if v_existing_group <> p_group_no then
      raise exception 'الفوج مسجل مسبقا ولا يمكن تغييره من هذه الصفحة';
    end if;
    update public.student_profiles
      set display_name = v_name
      where user_id = v_uid;
  else
    insert into public.student_profiles(user_id, group_no, display_name)
      values (v_uid, p_group_no, v_name);
  end if;
end;
$$;

revoke all on function public.complete_student_profile(text, smallint) from public, anon;
grant execute on function public.complete_student_profile(text, smallint) to authenticated;

commit;
notify pgrst, 'reload schema';
