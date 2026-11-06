-- info cc 404 — repair student onboarding when the auth trigger created a NULL group
-- Safe to run once or repeatedly. Does not delete or reassign existing non-NULL groups.
begin;

create or replace function public.complete_student_profile(
  p_display_name text,
  p_group_no smallint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_existing_group smallint;
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  if public.current_role() <> 'student' then
    raise exception 'هذه العملية مخصصة لحسابات الطلبة فقط';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'اسم المستخدم يجب أن يكون بين حرفين و40 حرفاً';
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
    -- A previously assigned group cannot be changed here.
    -- A NULL group created by the auth trigger can be completed exactly once.
    if v_existing_group is not null and v_existing_group <> p_group_no then
      raise exception 'الفوج مسجل مسبقاً ولا يمكن تغييره من صفحة التسجيل';
    end if;

    update public.student_profiles
      set display_name = v_name,
          group_no = coalesce(group_no, p_group_no)
      where user_id = v_uid;
  else
    insert into public.student_profiles(user_id, group_no, display_name)
      values (v_uid, p_group_no, v_name);
  end if;
end;
$function$;

revoke all on function public.complete_student_profile(text, smallint) from public, anon;
grant execute on function public.complete_student_profile(text, smallint) to authenticated;

-- Trigger functions are invoked by PostgreSQL triggers; they do not need public RPC access.
revoke all on function public.create_student_profile() from public, anon;

notify pgrst, 'reload schema';
commit;
