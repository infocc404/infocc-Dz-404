-- ============================================================================
-- info cc 404 — الجدول الزمني (schedule_entries)
-- شغّل هذا الملف مرة واحدة في Supabase > SQL Editor.
-- القراءة: كل المستخدمين المسجلين. الكتابة (إضافة/تعديل/حذف): المالك والمشرف فقط.
-- يعتمد على الدالة public.current_role() الموجودة سابقا (migration_security_v9.sql).
-- ============================================================================

create table if not exists public.schedule_entries (
  id bigint generated always as identity primary key,
  group_no smallint check (group_no is null or group_no between 1 and 10), -- NULL = كل الأفواج
  day_of_week smallint not null check (day_of_week between 0 and 6),       -- 0 = الأحد
  start_time time not null,
  end_time time not null,
  subject_id text not null,
  kind text not null check (kind in ('cours', 'td', 'tp')),
  room text,
  created_at timestamptz not null default now(),
  constraint schedule_entries_time_order check (end_time > start_time)
);

create index if not exists idx_schedule_entries_group on public.schedule_entries(group_no);

alter table public.schedule_entries enable row level security;

drop policy if exists "authenticated read schedule" on public.schedule_entries;
drop policy if exists "owner or admin manage schedule" on public.schedule_entries;

create policy "authenticated read schedule" on public.schedule_entries
  for select to authenticated
  using (true);

create policy "owner or admin manage schedule" on public.schedule_entries
  for all to authenticated
  using (public.current_role() in ('owner', 'admin'))
  with check (public.current_role() in ('owner', 'admin'));

grant select, insert, update, delete on public.schedule_entries to authenticated;
