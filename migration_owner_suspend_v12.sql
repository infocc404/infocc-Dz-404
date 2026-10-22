-- ============================================================================
-- info cc 404 — v12: إيقاف الحساب وإعادة تفعيله من قاعدة البيانات مباشرة
-- شغّل هذا الملف مرة واحدة في Supabase > SQL Editor (بعد v10 و v11).
-- لا يحتاج Edge Function ولا Supabase CLI ولا أي مفتاح سري.
-- المالك فقط (locoviber16@gmail.com) يستطيع استعمال الدالة، والتحقق يتم داخل قاعدة البيانات.
-- ============================================================================

begin;

create or replace function public.owner_set_user_suspended(p_user uuid, p_suspended boolean)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_target_email text;
begin
  -- 1) المالك فقط
  if auth.uid() is null
     or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may suspend or restore accounts.';
  end if;

  -- 2) الحساب المستهدف موجود وليس حساب المالك
  select lower(coalesce(u.email, '')) into v_target_email
  from auth.users u
  where u.id = p_user;

  if not found then
    raise exception 'The target account was not found.';
  end if;

  if v_target_email = 'locoviber16@gmail.com' or p_user = auth.uid() then
    raise exception 'The owner account is protected and cannot be suspended.';
  end if;

  -- 3) إيقاف (100 سنة) أو إعادة تفعيل
  update auth.users
  set banned_until = case
        when p_suspended then now() + interval '876000 hours'
        else null
      end
  where id = p_user;

  -- 4) عند الإيقاف: إنهاء جلسات الحساب فورا (إذا فشل هذا الجزء يبقى الإيقاف مطبقا)
  if p_suspended then
    begin
      delete from auth.sessions where user_id = p_user;
    exception when others then
      null;
    end;
  end if;
end;
$$;

revoke all on function public.owner_set_user_suspended(uuid, boolean) from public, anon;
grant execute on function public.owner_set_user_suspended(uuid, boolean) to authenticated;

commit;

notify pgrst, 'reload schema';
