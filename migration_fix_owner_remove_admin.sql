-- info cc 404: restore the owner-only admin removal RPC.
-- Run once in Supabase Dashboard > SQL Editor. This does not modify user data
-- except removing the selected user's row from public.admins when called by owner.

begin;

create or replace function public.owner_remove_admin(p_user uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_caller_email text;
  v_target_email text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select lower(coalesce(u.email, ''))
    into v_caller_email
  from auth.users u
  where u.id = auth.uid();

  if v_caller_email <> 'locoviber16@gmail.com' then
    raise exception 'Only the platform owner may remove administrators.';
  end if;

  if p_user is null then
    raise exception 'A target user is required.';
  end if;

  select lower(coalesce(u.email, ''))
    into v_target_email
  from auth.users u
  where u.id = p_user;

  if not found then
    raise exception 'The target account was not found.';
  end if;

  if v_target_email = 'locoviber16@gmail.com' or p_user = auth.uid() then
    raise exception 'The platform owner account is protected.';
  end if;

  delete from public.admins
  where user_id = p_user;
end;
$$;

revoke all on function public.owner_remove_admin(uuid) from public, anon;
grant execute on function public.owner_remove_admin(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
