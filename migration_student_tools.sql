-- Student tools for info cc 404: favorites and technical support reports.
-- Run once in Supabase SQL Editor after backing up the project.

create table if not exists public.student_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  file_id bigint not null references public.files(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, file_id)
);

alter table public.student_favorites enable row level security;
drop policy if exists "Users read own favorites" on public.student_favorites;
create policy "Users read own favorites" on public.student_favorites
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users add own favorites" on public.student_favorites;
create policy "Users add own favorites" on public.student_favorites
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "Users remove own favorites" on public.student_favorites;
create policy "Users remove own favorites" on public.student_favorites
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, delete on public.student_favorites to authenticated;

create table if not exists public.support_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('file','group','account','other')),
  title text not null check (char_length(title) between 3 and 140),
  details text not null check (char_length(details) between 5 and 3000),
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.support_reports enable row level security;
drop policy if exists "Users create own support reports" on public.support_reports;
create policy "Users create own support reports" on public.support_reports
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "Users read own support reports" on public.support_reports;
create policy "Users read own support reports" on public.support_reports
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Admins read support reports" on public.support_reports;
create policy "Admins read support reports" on public.support_reports
  for select to authenticated using (public.current_role() in ('owner','admin'));
drop policy if exists "Admins update support reports" on public.support_reports;
create policy "Admins update support reports" on public.support_reports
  for update to authenticated using (public.current_role() in ('owner','admin'))
  with check (public.current_role() in ('owner','admin'));

grant select, insert on public.support_reports to authenticated;
grant update (status, resolved_at) on public.support_reports to authenticated;

-- Helpful index for admin triage and each user's report history.
create index if not exists support_reports_status_created_idx on public.support_reports(status, created_at desc);
create index if not exists support_reports_user_created_idx on public.support_reports(user_id, created_at desc);
