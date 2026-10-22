-- ============================================================================
-- info cc 404 — ترحيل أمني شامل ومشدد (Migration Security v9)
-- ============================================================================
-- الغرض من هذا السكريبت:
-- 1. إلغاء الاعتماد نهائيا على raw_user_meta_data القابل للتعديل من العميل في تحديد الفوج.
-- 2. تثبيت جدول public.student_profiles كمصدر وحيد وموثق لأفواج الطلبة (Authoritative Source).
-- 3. حماية جدول public.uploaders من الاستعراض العام ومنع الزوار والطلبة من قراءة بياناته.
-- 4. تدقيق كافة دوال SECURITY DEFINER وضبط search_path وسحب صلاحيات PUBLIC الافتراضية.
-- 5. تشديد سياسات التخزين Storage لمنع الكتابة أو الحذف أو التجاوز بين الأفواج (Cross-group breach).
-- 6. إنشاء إجراء إداري موثق لتغيير أفواج الطلبة حصريا بواسطة المشرفين والمالك.
-- 
-- ملاحظة أمان:
-- هذا الترحيل تراكمي وآمن (Idempotent & Non-destructive) ولا يحذف أي حساب أو ملف قائم.
-- يجب تنفيذه في Supabase Dashboard > SQL Editor > Run بعد مراجعته والتأكد من بيئة العمل.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. التحقق من الجداول الأساسية وإضافة الأعمدة والقيود المطلوبة
-- ----------------------------------------------------------------------------

-- جدول المشرفين
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- جدول رؤساء الأقسام / رافعي الملفات
create table if not exists public.uploaders (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_no smallint not null check (group_no between 1 and 10),
  created_at timestamptz not null default now()
);

-- جدول تثبيت وتوثيق أفواج الطلبة
create table if not exists public.student_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_no smallint not null check (group_no between 1 and 10),
  created_at timestamptz not null default now()
);

-- جدول الملفات الدراسية
create table if not exists public.files (
  id bigint generated always as identity primary key,
  title text not null,
  semester text not null default 'S1' check (semester in ('S1', 'S2', 'Annuel')),
  subject text not null,
  kind text not null check (kind in ('cours', 'td', 'tp', 'exam', 'autre')),
  group_no smallint check (group_no is null or (group_no between 1 and 10)),
  path text not null,
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.files add column if not exists semester text not null default 'S1' check (semester in ('S1', 'S2', 'Annuel'));
alter table public.files add column if not exists group_no smallint check (group_no is null or (group_no between 1 and 10));
alter table public.files add column if not exists uploaded_by uuid references auth.users(id) on delete set null;

-- جدول معلومات الأساتذة
create table if not exists public.teacher_info (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('cours', 'td', 'tp')),
  subject_id text not null,
  group_no smallint check (group_no is null or (group_no between 1 and 10)),
  name text not null,
  email text,
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'teacher_info_unique'
  ) then
    alter table public.teacher_info add constraint teacher_info_unique unique nulls not distinct (kind, subject_id, group_no);
  end if;
end $$;

-- الفهارس لتسريع التحقق الأمني
create index if not exists idx_files_created_at on public.files(created_at desc);
create index if not exists idx_files_subject_kind on public.files(subject, kind);
create index if not exists idx_files_group_no on public.files(group_no);
create index if not exists idx_files_path on public.files(path);
create index if not exists idx_uploaders_group_no on public.uploaders(group_no);
create index if not exists idx_student_profiles_group on public.student_profiles(group_no);

-- تفعيل RLS على جميع الجداول
alter table public.admins enable row level security;
alter table public.uploaders enable row level security;
alter table public.student_profiles enable row level security;
alter table public.files enable row level security;
alter table public.teacher_info enable row level security;

-- ----------------------------------------------------------------------------
-- 2. ترحيل وتأمين أفواج الطلبة المسجلين سابقا (Preserve Existing Users)
-- ----------------------------------------------------------------------------

-- ترحيل آمن للمستخدمين الحاليين من بيانات التسجيل الأولى إلى student_profiles
-- نستخدم ON CONFLICT (user_id) DO NOTHING لضمان عدم الكتابة فوق أي سجل معتمد
insert into public.student_profiles (user_id, group_no)
select id, (nullif(raw_user_meta_data->>'group_no', ''))::smallint
from auth.users
where nullif(raw_user_meta_data->>'group_no', '') is not null
  and (nullif(raw_user_meta_data->>'group_no', ''))::smallint between 1 and 10
on conflict (user_id) do nothing;

-- ----------------------------------------------------------------------------
-- 3. معالج التسجيل الجديد (Signup Trigger) - INSERT ONLY
-- ----------------------------------------------------------------------------

-- المعالج يعمل فقط عند الإنشاء الأولي للحساب في auth.users
-- ولا يتم استدعاؤه مطلقا عند قيام المستخدم بتحديث بياناته الشخصية (raw_user_meta_data)
create or replace function public.handle_user_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_group smallint;
begin
  v_group := nullif(new.raw_user_meta_data ->> 'group_no', '')::smallint;
  if v_group is not null and v_group between 1 and 10 then
    insert into public.student_profiles (user_id, group_no)
    values (new.id, v_group)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

-- حذف المعالجات القديمة التي كانت تتفاعل مع Update
drop trigger if exists on_auth_user_created on auth.users;

-- ربط المعالج فقط عند INSERT لمنع أي تلاعب لاحق
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_user_signup();

-- ----------------------------------------------------------------------------
-- 4. دوال تحديد الرتب والأفواج الموثقة (Security Definer Functions)
-- ----------------------------------------------------------------------------

-- دالة فحص وتحديد الرتبة الحالية للمستخدم
create or replace function public.current_role()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    return 'anon';
  end if;

  select email into v_email from auth.users where id = v_uid;

  if v_email = 'locoviber16@gmail.com' then
    return 'owner';
  end if;

  if exists (select 1 from public.admins where user_id = v_uid) then
    return 'admin';
  end if;

  if exists (select 1 from public.uploaders where user_id = v_uid) then
    return 'uploader';
  end if;

  return 'student';
end;
$$;

-- دالة إرجاع الفوج المعتمد رسميا للمستخدم (Default Deny - No Metadata Fallback)
create or replace function public.my_group_no()
returns smallint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_group smallint;
begin
  if v_uid is null then
    return null;
  end if;

  -- 1. فحص جدول رؤساء الأفواج
  select group_no into v_group from public.uploaders where user_id = v_uid;
  if v_group is not null then
    return v_group;
  end if;

  -- 2. فحص جدول الطلبة المعتمد (student_profiles)
  select group_no into v_group from public.student_profiles where user_id = v_uid;
  if v_group is not null then
    return v_group;
  end if;

  -- إذا لم يوجد سجل معتمد، يتم الإرجاع null (رفض افتراضي دون الاعتماد على raw_user_meta_data)
  return null;
end;
$$;

-- دالة فحص وتحديد رتبة وفوج المستخدم للواجهة الأمامية والعميل
create or replace function public.my_role()
returns table (
  user_role text,
  uploader_group smallint,
  assigned_group smallint
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_group smallint;
  v_assigned smallint;
begin
  if v_uid is null then
    return query select 'anon'::text, null::smallint, null::smallint;
    return;
  end if;

  select email into v_email from auth.users where id = v_uid;
  v_assigned := public.my_group_no();

  -- 1. المالك (Owner)
  if v_email = 'locoviber16@gmail.com' then
    return query select 'owner'::text, null::smallint, v_assigned;
    return;
  end if;

  -- 2. المشرف (Admin)
  if exists (select 1 from public.admins where user_id = v_uid) then
    return query select 'admin'::text, null::smallint, v_assigned;
    return;
  end if;

  -- 3. رئيس الفوج (Uploader)
  select group_no into v_group from public.uploaders where user_id = v_uid;
  if found then
    return query select 'uploader'::text, v_group, v_assigned;
    return;
  end if;

  -- 4. طالب (Student)
  return query select 'student'::text, null::smallint, v_assigned;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. دوال الإدارة والتحكم والصلاحيات (Admin & Owner RPCs)
-- ----------------------------------------------------------------------------

-- استعراض قائمة المستخدمين للمالك والمشرفين
create or replace function public.owner_list_users()
returns table (
  id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  role text,
  group_no smallint
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_caller_role text := public.current_role();
begin
  if auth.uid() is null or v_caller_role not in ('owner', 'admin') then
    raise exception 'غير مصرح لك باستعراض قائمة المستخدمين.';
  end if;

  return query
  select
    u.id,
    u.email::text,
    u.created_at,
    u.last_sign_in_at,
    case
      when u.email = 'locoviber16@gmail.com' then 'owner'
      when a.user_id is not null then 'admin'
      when up.user_id is not null then 'uploader'
      else 'student'
    end as role,
    coalesce(up.group_no, sp.group_no) as group_no
  from auth.users u
  left join public.admins a on a.user_id = u.id
  left join public.uploaders up on up.user_id = u.id
  left join public.student_profiles sp on sp.user_id = u.id
  order by u.created_at desc;
end;
$$;

-- تعيين رئيس قسم / رافع ملفات لفوج محدد
create or replace function public.owner_set_uploader(p_user uuid, p_group smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_caller_role text := public.current_role();
  v_target_email text;
begin
  if auth.uid() is null or v_caller_role not in ('owner', 'admin') then
    raise exception 'غير مصرح لك بتعيين رؤساء الأقسام.';
  end if;

  if p_group is null or (p_group < 1 or p_group > 10) then
    raise exception 'رقم الفوج غير صحيح (يجب أن يكون بين 1 و 10).';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if not found then
    raise exception 'المستخدم غير موجود.';
  end if;

  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن تغيير رتبة أو صلاحيات المالك.';
  end if;

  if v_caller_role = 'admin' and exists (select 1 from public.admins where user_id = p_user) then
    raise exception 'لا يملك المشرف صلاحية تعديل رتبة مشرف آخر.';
  end if;

  delete from public.admins where user_id = p_user;

  insert into public.uploaders (user_id, group_no)
  values (p_user, p_group)
  on conflict (user_id) do update set group_no = excluded.group_no, created_at = now();
end;
$$;

-- إلغاء تعيين رئيس قسم
create or replace function public.owner_remove_uploader(p_user uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_caller_role text := public.current_role();
  v_target_email text;
begin
  if auth.uid() is null or v_caller_role not in ('owner', 'admin') then
    raise exception 'غير مصرح لك بإلغاء تعيين رؤساء الأقسام.';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if not found then
    raise exception 'المستخدم غير موجود.';
  end if;

  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن تعديل صلاحيات المالك.';
  end if;

  if v_caller_role = 'admin' and exists (select 1 from public.admins where user_id = p_user) then
    raise exception 'لا يملك المشرف صلاحية تعديل رتبة مشرف آخر.';
  end if;

  delete from public.uploaders where user_id = p_user;
end;
$$;

-- تعيين مشرف جديد (حصري لمالك المنصة فقط)
create or replace function public.owner_set_admin(p_user uuid)
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
  if v_caller_email != 'locoviber16@gmail.com' then
    raise exception 'صلاحية تعيين المشرفين مخصصة لمالك المنصة فقط.';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if not found then
    raise exception 'المستخدم غير موجود.';
  end if;

  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'المستخدم هو مالك المنصة بالفعل.';
  end if;

  delete from public.uploaders where user_id = p_user;

  insert into public.admins (user_id)
  values (p_user)
  on conflict (user_id) do nothing;
end;
$$;

-- إلغاء مشرف (حصري لمالك المنصة فقط)
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
  if v_caller_email != 'locoviber16@gmail.com' then
    raise exception 'صلاحية إلغاء المشرفين مخصصة لمالك المنصة فقط.';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن إلغاء رتبة مالك المنصة.';
  end if;

  delete from public.admins where user_id = p_user;
end;
$$;

-- تعيين أو تغيير فوج الطالب إداريا (إجراء إداري آمن)
create or replace function public.admin_set_student_group(p_user uuid, p_group smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_caller_role text := public.current_role();
  v_target_email text;
begin
  if auth.uid() is null or v_caller_role not in ('owner', 'admin') then
    raise exception 'غير مصرح لك بتعيين أو تعديل أفواج الطلبة.';
  end if;

  if p_group is null or p_group < 1 or p_group > 10 then
    raise exception 'رقم الفوج غير صحيح (يجب أن يكون بين 1 و 10).';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if not found then
    raise exception 'المستخدم غير موجود.';
  end if;

  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن تعيين فوج لمالك المنصة.';
  end if;

  insert into public.student_profiles (user_id, group_no)
  values (p_user, p_group)
  on conflict (user_id)
  do update set group_no = excluded.group_no, created_at = now();
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. سحب صلاحيات التنفيذ الافتراضية وضبط الأذونات بدقة (REVOKE & GRANT)
-- ----------------------------------------------------------------------------

revoke all on function public.current_role() from public;
revoke all on function public.my_group_no() from public;
revoke all on function public.my_role() from public;
revoke all on function public.handle_user_signup() from public;
revoke all on function public.owner_list_users() from public;
revoke all on function public.owner_set_uploader(uuid, smallint) from public;
revoke all on function public.owner_remove_uploader(uuid) from public;
revoke all on function public.owner_set_admin(uuid) from public;
revoke all on function public.owner_remove_admin(uuid) from public;
revoke all on function public.admin_set_student_group(uuid, smallint) from public;

grant execute on function public.current_role() to authenticated, anon;
grant execute on function public.my_group_no() to authenticated, anon;
grant execute on function public.my_role() to authenticated, anon;
grant execute on function public.handle_user_signup() to service_role;
grant execute on function public.owner_list_users() to authenticated;
grant execute on function public.owner_set_uploader(uuid, smallint) to authenticated;
grant execute on function public.owner_remove_uploader(uuid) to authenticated;
grant execute on function public.owner_set_admin(uuid) to authenticated;
grant execute on function public.owner_remove_admin(uuid) to authenticated;
grant execute on function public.admin_set_student_group(uuid, smallint) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. تحديث سياسات الأمان على مستوى الجداول (RLS Policies)
-- ----------------------------------------------------------------------------

-- تنظيف السياسات السابقة
drop policy if exists "admins read all or own" on public.admins;
drop policy if exists "admins managed by owner" on public.admins;

drop policy if exists "uploaders read all" on public.uploaders;
drop policy if exists "uploaders read own" on public.uploaders;
drop policy if exists "uploaders read authorized" on public.uploaders;
drop policy if exists "uploaders managed by admin or owner" on public.uploaders;

drop policy if exists "students read own profile" on public.student_profiles;
drop policy if exists "student_profiles managed by admin or owner" on public.student_profiles;

drop policy if exists "members read files" on public.files;
drop policy if exists "admin adds files" on public.files;
drop policy if exists "admin deletes files" on public.files;
drop policy if exists "uploaders or admin adds files" on public.files;
drop policy if exists "uploaders or admin deletes files" on public.files;
drop policy if exists "authorized read files" on public.files;
drop policy if exists "authorized insert files" on public.files;
drop policy if exists "authorized update files" on public.files;
drop policy if exists "authorized delete files" on public.files;

drop policy if exists "anyone reads teacher_info" on public.teacher_info;
drop policy if exists "owner or admin manages teacher_info" on public.teacher_info;

-- أ) سياسات جدول admins
create policy "admins read all or own" on public.admins
  for select to authenticated
  using (user_id = auth.uid() or public.current_role() in ('admin', 'owner'));

create policy "admins managed by owner" on public.admins
  for all to authenticated
  using (public.current_role() = 'owner')
  with check (public.current_role() = 'owner');

-- ب) سياسات جدول uploaders (محمية ومقتصرة على صاحب السجل أو الإدارة)
create policy "uploaders read authorized" on public.uploaders
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.current_role() in ('admin', 'owner')
  );

create policy "uploaders managed by admin or owner" on public.uploaders
  for all to authenticated
  using (public.current_role() in ('admin', 'owner'))
  with check (public.current_role() in ('admin', 'owner'));

-- ج) سياسات جدول student_profiles
create policy "students read own profile" on public.student_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.current_role() in ('admin', 'owner'));

create policy "student_profiles managed by admin or owner" on public.student_profiles
  for all to authenticated
  using (public.current_role() in ('admin', 'owner'))
  with check (public.current_role() in ('admin', 'owner'));

-- د) سياسات جدول files
create policy "authorized read files" on public.files
  for select to public
  using (
    public.current_role() in ('owner', 'admin')
    or kind = 'cours'
    or group_no is null
    or (
      public.my_group_no() is not null
      and group_no = public.my_group_no()
    )
  );

create policy "authorized insert files" on public.files
  for insert to authenticated
  with check (
    public.current_role() in ('owner', 'admin')
    or (
      public.current_role() = 'uploader'
      and group_no = public.my_group_no()
      and kind in ('td', 'tp', 'exam', 'autre')
      and path like 'g' || public.my_group_no() || '/%'
    )
  );

create policy "authorized update files" on public.files
  for update to authenticated
  using (
    public.current_role() in ('owner', 'admin')
    or (
      public.current_role() = 'uploader'
      and group_no = public.my_group_no()
    )
  )
  with check (
    public.current_role() in ('owner', 'admin')
    or (
      public.current_role() = 'uploader'
      and group_no = public.my_group_no()
      and kind in ('td', 'tp', 'exam', 'autre')
      and path like 'g' || public.my_group_no() || '/%'
    )
  );

create policy "authorized delete files" on public.files
  for delete to authenticated
  using (
    public.current_role() in ('owner', 'admin')
    or (
      public.current_role() = 'uploader'
      and group_no = public.my_group_no()
    )
  );

-- هـ) سياسات جدول teacher_info
create policy "anyone reads teacher_info" on public.teacher_info
  for select to public
  using (true);

create policy "owner or admin manages teacher_info" on public.teacher_info
  for all to authenticated
  using (public.current_role() in ('owner', 'admin'))
  with check (public.current_role() in ('owner', 'admin'));

-- ----------------------------------------------------------------------------
-- 8. سياسات التخزين السحابي المحصنة (Storage: course-files)
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('course-files', 'course-files', false)
on conflict (id) do update set public = false;

drop policy if exists "members read storage" on storage.objects;
drop policy if exists "admin uploads storage" on storage.objects;
drop policy if exists "admin deletes storage" on storage.objects;
drop policy if exists "authorized uploads storage" on storage.objects;
drop policy if exists "authorized deletes storage" on storage.objects;
drop policy if exists "authorized read storage" on storage.objects;
drop policy if exists "authorized upload storage" on storage.objects;
drop policy if exists "authorized update storage" on storage.objects;
drop policy if exists "authorized delete storage" on storage.objects;

-- قراءة الملفات في مساحة التخزين (SELECT)
create policy "authorized read storage" on storage.objects
  for select to public
  using (
    bucket_id = 'course-files'
    and (
      public.current_role() in ('owner', 'admin')
      or storage.objects.name like 'common/%'
      or (
        public.my_group_no() is not null
        and storage.objects.name like 'g' || public.my_group_no() || '/%'
      )
      or exists (
        select 1 from public.files f
        where f.path = storage.objects.name
          and (
            f.kind = 'cours'
            or f.group_no is null
            or (public.my_group_no() is not null and f.group_no = public.my_group_no())
          )
      )
    )
  );

-- رفع الملفات في مساحة التخزين (INSERT)
create policy "authorized upload storage" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'course-files'
    and (
      public.current_role() in ('owner', 'admin')
      or (
        public.current_role() = 'uploader'
        and public.my_group_no() is not null
        and storage.objects.name like 'g' || public.my_group_no() || '/%'
      )
    )
  );

-- تعديل الملفات في مساحة التخزين (UPDATE)
create policy "authorized update storage" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'course-files'
    and (
      public.current_role() in ('owner', 'admin')
      or (
        public.current_role() = 'uploader'
        and public.my_group_no() is not null
        and storage.objects.name like 'g' || public.my_group_no() || '/%'
      )
    )
  )
  with check (
    bucket_id = 'course-files'
    and (
      public.current_role() in ('owner', 'admin')
      or (
        public.current_role() = 'uploader'
        and public.my_group_no() is not null
        and storage.objects.name like 'g' || public.my_group_no() || '/%'
      )
    )
  );

-- حذف الملفات من مساحة التخزين (DELETE)
create policy "authorized delete storage" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'course-files'
    and (
      public.current_role() in ('owner', 'admin')
      or (
        public.current_role() = 'uploader'
        and public.my_group_no() is not null
        and (
          storage.objects.name like 'g' || public.my_group_no() || '/%'
          or exists (
            select 1 from public.files f
            where f.path = storage.objects.name
              and f.group_no = public.my_group_no()
          )
        )
      )
    )
  );

commit;

-- ============================================================================
-- ملحق: خطة التحقق والتعافي (Verification & Rollback Plan)
-- ============================================================================
-- 1. للتحقق من نجاح الترحيل:
--    - استدع دالة: select * from public.my_role();
--    - افحص سياسات uploaders:
--      select policyname, roles, cmd from pg_policies where tablename = 'uploaders';
--    - افحص أن دالة my_group_no لا تستعلم raw_user_meta_data:
--      select prosrc from pg_proc where proname = 'my_group_no';
--
-- 2. خطة التراجع السريع عند الطوارئ (Rollback):
--    - يمكن إعادة تطبيق سكريبت migration_security_v8.sql إذا تطلب الأمر.
-- ============================================================================
