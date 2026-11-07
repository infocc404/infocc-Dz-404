-- QCM recovery, multi-answer grading, and student polls
begin;

alter table public.quizzes add column if not exists deleted_at timestamptz;
alter table public.quizzes add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table public.quiz_questions add column if not exists deleted_at timestamptz;
alter table public.quiz_questions add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table public.quiz_attempt_answers add column if not exists selected_option_ids uuid[] not null default '{}'::uuid[];

create index if not exists quizzes_deleted_at_idx on public.quizzes(deleted_at) where deleted_at is not null;
create index if not exists quiz_questions_deleted_at_idx on public.quiz_questions(deleted_at) where deleted_at is not null;

create table if not exists public.quiz_correct_options (
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  option_id uuid not null references public.quiz_options(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(question_id, option_id)
);
insert into public.quiz_correct_options(question_id, option_id)
select question_id, correct_option_id from public.quiz_answer_keys
on conflict do nothing;

alter table public.quiz_correct_options enable row level security;
revoke all on public.quiz_correct_options from anon;
grant select, insert, delete on public.quiz_correct_options to authenticated;
drop policy if exists quiz_correct_options_staff_read on public.quiz_correct_options;
create policy quiz_correct_options_staff_read on public.quiz_correct_options for select to authenticated
using (
  (select public.current_role()) in ('owner','admin')
  or exists (
    select 1 from public.quiz_questions qq join public.quizzes q on q.id=qq.quiz_id
    join public.uploaders up on up.user_id=(select auth.uid())
    where qq.id=quiz_correct_options.question_id and q.group_no=up.group_no
      and (select public.current_role())='uploader'
  )
);
drop policy if exists quiz_correct_options_staff_insert on public.quiz_correct_options;
create policy quiz_correct_options_staff_insert on public.quiz_correct_options for insert to authenticated
with check (
  exists (
    select 1 from public.quiz_questions qq join public.quizzes q on q.id=qq.quiz_id
    where qq.id=quiz_correct_options.question_id
      and (
        (select public.current_role()) in ('owner','admin')
        or ((select public.current_role())='uploader' and q.group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
      )
  )
  and exists (select 1 from public.quiz_options o where o.id=quiz_correct_options.option_id and o.question_id=quiz_correct_options.question_id)
);
drop policy if exists quiz_correct_options_staff_delete on public.quiz_correct_options;
create policy quiz_correct_options_staff_delete on public.quiz_correct_options for delete to authenticated
using (
  exists (
    select 1 from public.quiz_questions qq join public.quizzes q on q.id=qq.quiz_id
    where qq.id=quiz_correct_options.question_id
      and (
        (select public.current_role()) in ('owner','admin')
        or ((select public.current_role())='uploader' and q.group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
      )
  )
);

-- Students and uploaders must not see deleted content; owner/admin retain access for recovery.
drop policy if exists quizzes_read_published on public.quizzes;
create policy quizzes_read_published on public.quizzes for select to authenticated
using (
  (select public.current_role()) in ('owner','admin')
  or (
    deleted_at is null and (
      ((select public.current_role())='uploader' and group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
      or (is_published and (group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=(select auth.uid()) and sp.group_no=quizzes.group_no)))
    )
  )
);
drop policy if exists quiz_questions_read on public.quiz_questions;
create policy quiz_questions_read on public.quiz_questions for select to authenticated
using (
  exists (
    select 1 from public.quizzes q where q.id=quiz_questions.quiz_id
    and (
      (select public.current_role()) in ('owner','admin')
      or (q.deleted_at is null and quiz_questions.deleted_at is null and (
        ((select public.current_role())='uploader' and q.group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
        or (q.is_published and (q.group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=(select auth.uid()) and sp.group_no=q.group_no)))
      ))
    )
  )
);
drop policy if exists quiz_options_read on public.quiz_options;
create policy quiz_options_read on public.quiz_options for select to authenticated
using (
  exists (
    select 1 from public.quiz_questions qq join public.quizzes q on q.id=qq.quiz_id
    where qq.id=quiz_options.question_id
    and (
      (select public.current_role()) in ('owner','admin')
      or (q.deleted_at is null and qq.deleted_at is null and (
        ((select public.current_role())='uploader' and q.group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
        or (q.is_published and (q.group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=(select auth.uid()) and sp.group_no=q.group_no)))
      ))
    )
  )
);

create or replace function public.owner_restore_quiz(p_quiz_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,public,auth,pg_temp
as $$
begin
  if auth.uid() is null or public.current_role() <> 'owner' then raise exception 'Owner access required'; end if;
  update public.quizzes set deleted_at=null, deleted_by=null, updated_at=now() where id=p_quiz_id;
  if not found then raise exception 'Quiz not found'; end if;
end;
$$;
revoke all on function public.owner_restore_quiz(uuid) from public, anon;
grant execute on function public.owner_restore_quiz(uuid) to authenticated;

create or replace function public.owner_restore_quiz_question(p_question_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,public,auth,pg_temp
as $$
begin
  if auth.uid() is null or public.current_role() <> 'owner' then raise exception 'Owner access required'; end if;
  update public.quiz_questions set deleted_at=null, deleted_by=null where id=p_question_id;
  if not found then raise exception 'Question not found'; end if;
end;
$$;
revoke all on function public.owner_restore_quiz_question(uuid) from public, anon;
grant execute on function public.owner_restore_quiz_question(uuid) to authenticated;

create or replace function public.submit_quiz_attempt(p_quiz_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,auth,pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_quiz public.quizzes%rowtype;
  v_attempt uuid;
  v_total numeric(8,2):=0;
  v_score numeric(8,2):=0;
  v_count integer:=0;
  v_item jsonb;
  v_question uuid;
  v_selected uuid[];
  v_correct uuid[];
  v_points numeric(6,2);
  v_is_correct boolean;
  v_bad_count integer;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if coalesce(public.is_account_active(),false) is not true then raise exception 'Account is inactive'; end if;
  if p_answers is null or jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers)=0 or jsonb_array_length(p_answers)>100 then
    raise exception 'Invalid answers payload';
  end if;
  select * into v_quiz from public.quizzes q
  where q.id=p_quiz_id and q.is_published and q.deleted_at is null
    and (q.group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=v_uid and sp.group_no=q.group_no));
  if not found then raise exception 'Quiz not found or not available'; end if;

  insert into public.quiz_attempts(quiz_id,student_id) values(p_quiz_id,v_uid) returning id into v_attempt;
  for v_item in select value from jsonb_array_elements(p_answers) loop
    begin
      v_question := (v_item->>'question_id')::uuid;
      if jsonb_typeof(v_item->'option_ids')='array' then
        select coalesce(array_agg(x::uuid order by x::uuid),'{}'::uuid[]) into v_selected
        from jsonb_array_elements_text(v_item->'option_ids') x;
      elsif nullif(v_item->>'option_id','') is not null then
        v_selected := array[(v_item->>'option_id')::uuid];
      else
        v_selected := '{}'::uuid[];
      end if;
    exception when others then raise exception 'Invalid answer item'; end;

    select qq.points into v_points from public.quiz_questions qq
    where qq.id=v_question and qq.quiz_id=p_quiz_id and qq.deleted_at is null;
    if not found then raise exception 'Question does not belong to this active quiz'; end if;

    select coalesce(array_agg(distinct x order by x),'{}'::uuid[]) into v_selected
    from unnest(v_selected) x;
    select coalesce(array_agg(co.option_id order by co.option_id),'{}'::uuid[]) into v_correct
    from public.quiz_correct_options co where co.question_id=v_question;
    if cardinality(v_correct)=0 then
      select array[ak.correct_option_id] into v_correct from public.quiz_answer_keys ak where ak.question_id=v_question;
    end if;
    if cardinality(v_correct)=0 then raise exception 'Quiz answer key is incomplete'; end if;
    select count(*) into v_bad_count from unnest(v_selected) x
    where not exists(select 1 from public.quiz_options o where o.id=x and o.question_id=v_question);
    if v_bad_count>0 then raise exception 'Selected option does not belong to question'; end if;

    v_is_correct := v_selected=v_correct;
    v_total:=v_total+v_points;
    if v_is_correct then v_score:=v_score+v_points; end if;
    v_count:=v_count+1;
    insert into public.quiz_attempt_answers(attempt_id,question_id,selected_option_id,selected_option_ids,is_correct,awarded_points)
    values(v_attempt,v_question,v_selected[1],v_selected,v_is_correct,case when v_is_correct then v_points else 0 end);
  end loop;
  if v_count<>(select count(*) from public.quiz_questions where quiz_id=p_quiz_id and deleted_at is null) then
    raise exception 'Please answer every active question exactly once';
  end if;
  update public.quiz_attempts set score=v_score,max_score=v_total,answers_count=v_count where id=v_attempt;
  return jsonb_build_object('attempt_id',v_attempt,'score',v_score,'max_score',v_total,'answers_count',v_count);
end;
$$;
revoke all on function public.submit_quiz_attempt(uuid,jsonb) from public, anon;
grant execute on function public.submit_quiz_attempt(uuid,jsonb) to authenticated;

create table if not exists public.course_polls (
  id uuid primary key default gen_random_uuid(),
  title text not null check(char_length(title) between 3 and 240),
  description text not null default '',
  group_no smallint check(group_no between 1 and 10),
  allow_multiple boolean not null default false,
  is_active boolean not null default true,
  closes_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create table if not exists public.course_poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.course_polls(id) on delete cascade,
  option_text text not null check(char_length(option_text) between 1 and 500),
  position integer not null default 1 check(position>0),
  unique(poll_id,position)
);
create table if not exists public.course_poll_votes (
  poll_id uuid not null references public.course_polls(id) on delete cascade,
  option_id uuid not null references public.course_poll_options(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(poll_id,option_id,user_id)
);
create index if not exists course_poll_votes_poll_idx on public.course_poll_votes(poll_id);
alter table public.course_polls enable row level security;
alter table public.course_poll_options enable row level security;
alter table public.course_poll_votes enable row level security;
revoke all on public.course_poll_votes from anon,authenticated;
grant select,insert on public.course_polls to authenticated;
grant select,insert on public.course_poll_options to authenticated;
drop policy if exists course_polls_read on public.course_polls;
create policy course_polls_read on public.course_polls for select to authenticated
using (
  (select public.current_role()) in ('owner','admin')
  or ((select public.current_role())='uploader' and group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
  or (is_active and (group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=(select auth.uid()) and sp.group_no=course_polls.group_no)))
);
drop policy if exists course_polls_staff_insert on public.course_polls;
create policy course_polls_staff_insert on public.course_polls for insert to authenticated
with check (
  created_by=(select auth.uid()) and (
    (select public.current_role()) in ('owner','admin')
    or ((select public.current_role())='uploader' and group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1) and group_no is not null)
  )
);
drop policy if exists course_poll_options_read on public.course_poll_options;
create policy course_poll_options_read on public.course_poll_options for select to authenticated
using (exists(select 1 from public.course_polls p where p.id=poll_id));
drop policy if exists course_poll_options_staff_insert on public.course_poll_options;
create policy course_poll_options_staff_insert on public.course_poll_options for insert to authenticated
with check (exists(select 1 from public.course_polls p where p.id=poll_id and (
  (select public.current_role()) in ('owner','admin') or
  ((select public.current_role())='uploader' and p.group_no=(select up.group_no from public.uploaders up where up.user_id=(select auth.uid()) limit 1))
)));

create or replace function public.cast_course_poll_vote(p_poll_id uuid,p_option_ids uuid[])
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,auth,pg_temp
as $$
declare v_uid uuid:=auth.uid(); v_poll public.course_polls%rowtype; v_count integer;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if coalesce(public.is_account_active(),false) is not true then raise exception 'Account is inactive'; end if;
  select * into v_poll from public.course_polls p where p.id=p_poll_id and p.is_active
    and (p.closes_at is null or p.closes_at>now())
    and (p.group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=v_uid and sp.group_no=p.group_no));
  if not found then raise exception 'Poll is not available'; end if;
  if p_option_ids is null or cardinality(p_option_ids)<1 or cardinality(p_option_ids)>20 then raise exception 'Select at least one option'; end if;
  if not v_poll.allow_multiple and cardinality(p_option_ids)<>1 then raise exception 'This poll allows one choice only'; end if;
  if (select count(distinct x) from unnest(p_option_ids) x)<>cardinality(p_option_ids) then raise exception 'Duplicate options'; end if;
  select count(*) into v_count from unnest(p_option_ids) x join public.course_poll_options o on o.id=x and o.poll_id=p_poll_id;
  if v_count<>cardinality(p_option_ids) then raise exception 'Invalid poll option'; end if;
  delete from public.course_poll_votes where poll_id=p_poll_id and user_id=v_uid;
  insert into public.course_poll_votes(poll_id,option_id,user_id) select p_poll_id,x,v_uid from unnest(p_option_ids) x;
  return public.get_course_poll_results(p_poll_id);
end;
$$;

create or replace function public.get_course_poll_results(p_poll_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,auth,pg_temp
as $$
declare v_uid uuid:=auth.uid(); v_poll public.course_polls%rowtype; v_result jsonb;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select * into v_poll from public.course_polls p where p.id=p_poll_id
    and ((select public.current_role()) in ('owner','admin','uploader')
      or p.group_no is null or exists(select 1 from public.student_profiles sp where sp.user_id=v_uid and sp.group_no=p.group_no));
  if not found then raise exception 'Poll not found'; end if;
  select jsonb_build_object(
    'poll_id',p_poll_id,
    'total_votes',(select count(distinct user_id) from public.course_poll_votes where poll_id=p_poll_id),
    'my_votes',coalesce((select jsonb_agg(option_id) from public.course_poll_votes where poll_id=p_poll_id and user_id=v_uid),'[]'::jsonb),
    'options',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'text',o.option_text,'votes',(select count(*) from public.course_poll_votes v where v.poll_id=p_poll_id and v.option_id=o.id)) order by o.position) from public.course_poll_options o where o.poll_id=p_poll_id),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.cast_course_poll_vote(uuid,uuid[]) from public,anon;
revoke all on function public.get_course_poll_results(uuid) from public,anon;
grant execute on function public.cast_course_poll_vote(uuid,uuid[]) to authenticated;
grant execute on function public.get_course_poll_results(uuid) to authenticated;

commit;
