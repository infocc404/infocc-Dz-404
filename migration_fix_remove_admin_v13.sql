-- info cc 404 — v13: إصلاح "Could not find the function public.owner_remove_admin(p_user)"
-- شغّل هذا الملف كاملا مرة واحدة في Supabase > SQL Editor ثم اضغط Run.
begin;

-- حذف أي نسخ قديمة من الدالة بتوقيعات مختلفة (قد تسبب تعارضا في schema cache)
drop function if exists public.owner_remove_admin(uuid);
drop function if exists public.owner_remove_admin(text);
drop function if exists public.owner_remove_admin(bigint);

create or replace function public.owner_remove_admin(p_user uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_caller_email text;
  v_target_email text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولا.';
  end if;

  select email into v_caller_email from auth.users where id = auth.uid();
  if v_caller_email is distinct from 'locoviber16@gmail.com' then
    raise exception 'صلاحية إلغاء المشرفين مخصصة لمالك المنصة فقط.';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن إلغاء رتبة مالك المنصة.';
  end if;

  delete from public.admins where user_id = p_user;
end;
$$;

revoke all on function public.owner_remove_admin(uuid) from public, anon;
grant execute on function public.owner_remove_admin(uuid) to authenticated;

commit;

-- تحديث كاش واجهة Supabase حتى تظهر الدالة فورا
notify pgrst, 'reload schema';
