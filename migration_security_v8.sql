-- ============================================================================
-- info cc 404 — ترحيل أمني منفصل لقاعدة البيانات الحالية (Migration Security v8)
-- ============================================================================
-- ملاحظة هامة: هذا السكريبت ترحيلي آمن (Idempotent & Non-destructive).
-- لا يقوم بحذف أي جداول أو بيانات سابقة، بل يُحدّث الهياكل والسياسات والدوال فقط.
-- التطبيق: في Supabase Dashboard > SQL Editor > New query ثم Run.
-- ============================================================================

begin;

-- 1. جدول المشرفين (admins)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- 2. جدول رافعي الملفات المفوضين (uploaders)
create table if not exists public.uploaders (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_no smallint not null check (group_no between 1 and 10),
  created_at timestamptz not null default now()
);

-- 3. جدول تثبيت أفواج الطلبة (student_profiles)
create table if not exists public.student_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_no smallint not null check (group_no between 1 and 10),
  created_at timestamptz not null default now()
);

-- 4. التأكد من أعمدة جدول الملفات (files)
alter table public.files add column if not exists semester text not null default 'S1' check (semester in ('S1', 'S2', 'Annuel'));
alter table public.files add column if not exists group_no smallint check (group_no is null or (group_no between 1 and 10));
alter table public.files add column if not exists uploaded_by uuid references auth.users(id) on delete set null;

-- 5. التأكد من جدول الأساتذة (teacher_info)
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

-- 6. فهارس الأداء والأمان
create index if not exists idx_files_created_at on public.files(created_at desc);
create index if not exists idx_files_subject_kind on public.files(subject, kind);
create index if not exists idx_files_group_no on public.files(group_no);
create index if not exists idx_files_path on public.files(path);
create index if not exists idx_uploaders_group_no on public.uploaders(group_no);
create index if not exists idx_student_profiles_group on public.student_profiles(group_no);

-- 7. تفعيل RLS على جميع الجداول
alter table public.admins enable row level security;
alter table public.uploaders enable row level security;
alter table public.student_profiles enable row level security;
alter table public.files enable row level security;
alter table public.teacher_info enable row level security;

-- 8. دوال تحديد الرتب والفوج (Security Definer)

create or replace function public.current_role()
returns text
language plpgsql
security definer
set search_path = public, auth
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

create or replace function public.my_group_no()
returns smallint
language plpgsql
security definer
set search_path = public, auth
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_group smallint;
begin
  if v_uid is null then
    return null;
  end if;

  select group_no into v_group from public.uploaders where user_id = v_uid;
  if v_group is not null then
    return v_group;
  end if;

  select group_no into v_group from public.student_profiles where user_id = v_uid;
  if v_group is not null then
    return v_group;
  end if;

  select nullif(raw_user_meta_data->>'group_no', '')::smallint into v_group
  from auth.users where id = v_uid;

  return v_group;
end;
$$;

create or replace function public.my_role()
returns table (
  user_role text,
  uploader_group smallint
)
language plpgsql
security definer
set search_path = public, auth
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_group smallint;
begin
  if v_uid is null then
    return query select 'anon'::text, null::smallint;
    return;
  end if;

  select email into v_email from auth.users where id = v_uid;

  if v_email = 'locoviber16@gmail.com' then
    return query select 'owner'::text, null::smallint;
    return;
  end if;

  if exists (select 1 from public.admins where user_id = v_uid) then
    return query select 'admin'::text, null::smallint;
    return;
  end if;

  select group_no into v_group from public.uploaders where user_id = v_uid;
  if found then
    return query select 'uploader'::text, v_group;
    return;
  end if;

  return query select 'student'::text, null::smallint;
end;
$$;

-- ترحيل بيانات أفواج الطلبة الحالية من auth.users بأمان
insert into public.student_profiles (user_id, group_no)
select id, (nullif(raw_user_meta_data->>'group_no', ''))::smallint
from auth.users
where nullif(raw_user_meta_data->>'group_no', '') is not null
  and (nullif(raw_user_meta_data->>'group_no', ''))::smallint between 1 and 10
on conflict (user_id) do nothing;

create or replace function public.handle_user_signup()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_group smallint;
begin
  v_group := nullif(new.raw_user_meta_data ->> 'group_no', '')::smallint;
  if v_group is not null and v_group between 1 and 10 then
    insert into public.student_profiles (user_id, group_no)
    values (new.id, v_group)
    on conflict (user_id) do update set group_no = excluded.group_no;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public.handle_user_signup();

-- 9. دوال الإدارة والتحكم (RPCs)
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
set search_path = public, auth
as $$
begin
  if public.current_role() not in ('owner', 'admin') then
    raise exception 'غير مصرح لك بالوصول لقائمة المستخدمين';
  end if;

  return query
  select
    u.id,
    u.email::text,
    u.created_at,
    u.last_sign_in_at,
    case
      when u.email = 'locoviber16@gmail.com' then 'owner'
      when exists (select 1 from public.admins a where a.user_id = u.id) then 'admin'
      when exists (select 1 from public.uploaders up where up.user_id = u.id) then 'uploader'
      else 'student'
    end as role,
    coalesce(
      (select up.group_no from public.uploaders up where up.user_id = u.id limit 1),
      (select sp.group_no from public.student_profiles sp where sp.user_id = u.id limit 1),
      nullif(u.raw_user_meta_data->>'group_no', '')::smallint
    ) as group_no
  from auth.users u
  order by u.created_at desc;
end;
$$;

create or replace function public.owner_set_uploader(p_user uuid, p_group smallint)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_target_email text;
begin
  if public.current_role() not in ('owner', 'admin') then
    raise exception 'غير مصرح لك بتعيين رؤساء الأقسام';
  end if;

  if p_group is null or p_group < 1 or p_group > 10 then
    raise exception 'رقم الفوج غير صحيح، يجب أن يكون بين 1 و 10';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if not found then
    raise exception 'المستخدم غير موجود';
  end if;

  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن تغيير رتبة مالك المنصة';
  end if;

  delete from public.admins where user_id = p_user;

  insert into public.uploaders (user_id, group_no)
  values (p_user, p_group)
  on conflict (user_id)
  do update set group_no = excluded.group_no;
end;
$$;

create or replace function public.owner_remove_uploader(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if public.current_role() not in ('owner', 'admin') then
    raise exception 'غير مصرح لك بإلغاء رؤساء الأقسام';
  end if;

  delete from public.uploaders where user_id = p_user;
end;
$$;

create or replace function public.owner_set_admin(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_target_email text;
begin
  if public.current_role() != 'owner' then
    raise exception 'صلاحية تعيين المشرفين مخصصة لمالك المنصة فقط';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if not found then
    raise exception 'المستخدم غير موجود';
  end if;

  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'المستخدم هو مالك المنصة بالفعل';
  end if;

  delete from public.uploaders where user_id = p_user;

  insert into public.admins (user_id)
  values (p_user)
  on conflict (user_id) do nothing;
end;
$$;

create or replace function public.owner_remove_admin(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_target_email text;
begin
  if public.current_role() != 'owner' then
    raise exception 'صلاحية إلغاء المشرفين مخصصة لمالك المنصة فقط';
  end if;

  select email into v_target_email from auth.users where id = p_user;
  if v_target_email = 'locoviber16@gmail.com' then
    raise exception 'لا يمكن إلغاء رتبة مالك المنصة';
  end if;

  delete from public.admins where user_id = p_user;
end;
$$;

-- 10. تحديث سياسات الأمان للجداول (RLS)

drop policy if exists "members read files" on public.files;
drop policy if exists "admin adds files" on public.files;
drop policy if exists "admin deletes files" on public.files;
drop policy if exists "uploaders or admin adds files" on public.files;
drop policy if exists "uploaders or admin deletes files" on public.files;
drop policy if exists "authorized read files" on public.files;
drop policy if exists "authorized insert files" on public.files;
drop policy if exists "authorized update files" on public.files;
drop policy if exists "authorized delete files" on public.files;

drop policy if exists "admins read all or own" on public.admins;
drop policy if exists "admins managed by owner" on public.admins;
create policy "admins read all or own" on public.admins
  for select to authenticated
  using (user_id = auth.uid() or public.current_role() in ('admin', 'owner'));

create policy "admins managed by owner" on public.admins
  for all to authenticated
  using (public.current_role() = 'owner')
  with check (public.current_role() = 'owner');

drop policy if exists "uploaders read all" on public.uploaders;
drop policy if exists "uploaders managed by admin or owner" on public.uploaders;
create policy "uploaders read all" on public.uploaders
  for select to public
  using (true);

create policy "uploaders managed by admin or owner" on public.uploaders
  for all to authenticated
  using (public.current_role() in ('admin', 'owner'))
  with check (public.current_role() in ('admin', 'owner'));

drop policy if exists "students read own profile" on public.student_profiles;
drop policy if exists "student_profiles managed by admin or owner" on public.student_profiles;
create policy "students read own profile" on public.student_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.current_role() in ('admin', 'owner'));

create policy "student_profiles managed by admin or owner" on public.student_profiles
  for all to authenticated
  using (public.current_role() in ('admin', 'owner'))
  with check (public.current_role() in ('admin', 'owner'));

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

drop policy if exists "anyone reads teacher_info" on public.teacher_info;
drop policy if exists "owner or admin manages teacher_info" on public.teacher_info;

create policy "anyone reads teacher_info" on public.teacher_info
  for select to public
  using (true);

create policy "owner or admin manages teacher_info" on public.teacher_info
  for all to authenticated
  using (public.current_role() in ('owner', 'admin'))
  with check (public.current_role() in ('owner', 'admin'));

-- 11. تحديث سياسات مساحة التخزين (Storage: course-files)

insert into storage.buckets (id, name, public)
values ('course-files', 'course-files', false)
on conflict (id) do nothing;

drop policy if exists "members read storage" on storage.objects;
drop policy if exists "admin uploads storage" on storage.objects;
drop policy if exists "admin deletes storage" on storage.objects;
drop policy if exists "authorized uploads storage" on storage.objects;
drop policy if exists "authorized deletes storage" on storage.objects;
drop policy if exists "authorized read storage" on storage.objects;
drop policy if exists "authorized upload storage" on storage.objects;
drop policy if exists "authorized delete storage" on storage.objects;

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
