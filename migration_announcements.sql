-- Announcements for info cc 404
-- Run once in Supabase SQL Editor.
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 140),
  body text not null check (char_length(trim(body)) between 1 and 5000),
  priority text not null default 'normal' check (priority in ('urgent','important','normal')),
  created_by uuid not null references auth.users(id) on delete cascade,
  author_label text,
  created_at timestamptz not null default now()
);

alter table public.announcements enable row level security;
revoke all on public.announcements from anon;
grant select, insert, update, delete on public.announcements to authenticated;

drop policy if exists "Authenticated users can read announcements" on public.announcements;
create policy "Authenticated users can read announcements"
  on public.announcements for select to authenticated
  using (public.is_account_active());

drop policy if exists "Authorized staff can create announcements" on public.announcements;
create policy "Authorized staff can create announcements"
  on public.announcements for insert to authenticated
  with check (
    public.is_account_active()
    and created_by = auth.uid()
    and public.current_role() in ('owner','admin','uploader')
  );

drop policy if exists "Authorized staff can update announcements" on public.announcements;
create policy "Authorized staff can update announcements"
  on public.announcements for update to authenticated
  using (public.is_account_active() and public.current_role() in ('owner','admin','uploader'))
  with check (public.is_account_active() and public.current_role() in ('owner','admin','uploader'));

drop policy if exists "Authorized staff can delete announcements" on public.announcements;
create policy "Authorized staff can delete announcements"
  on public.announcements for delete to authenticated
  using (public.is_account_active() and public.current_role() in ('owner','admin','uploader'));
