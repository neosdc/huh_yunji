-- 구구단 놀이터 Supabase 스키마
--
-- 사용법: Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 한 번 실행하세요.
-- 다시 실행해도 안전하도록 작성했습니다(이미 있는 것은 건너뜁니다).
--
-- 구조
--   로그인한 부모 계정(auth.users) 하나에 아이 프로필(profiles)이 여러 개 달리고,
--   프로필마다 학습 진행·설정(profile_state)과 풀이 기록(attempts)이 쌓입니다.
--
-- 보안
--   앱의 anon 키는 공개되는 값이라, 데이터는 전부 행 단위 접근 제어(RLS)로 지킵니다.
--   모든 테이블에서 RLS를 켜고, 로그인한 본인 계정의 프로필에 딸린 행만 읽고 쓸 수 있게 합니다.
--   로그인하지 않은 요청(anon 역할)은 어떤 테이블도 읽거나 쓸 수 없습니다.
--
-- 가입 승인
--   Google로 처음 로그인하면 members 에 'pending'(승인 대기) 행이 자동으로 생깁니다.
--   관리자가 status 를 'approved' 로 바꿔 주기 전에는 프로필·진행·기록 어디에도 읽거나 쓸 수 없습니다(RLS 로 막음).
--   승인:  update public.members set status = 'approved', decided_at = now() where email = '부모님@gmail.com';
--   차단:  update public.members set status = 'blocked'  ... (승인했던 계정도 바로 접근이 막힙니다)
--   이 스크립트를 처음 실행할 때 이미 가입해 있던 계정은 자동으로 승인 처리됩니다.

-- 0) 가입 승인 -----------------------------------------------------------------
create table if not exists public.members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  status     text not null default 'pending' check (status in ('pending', 'approved', 'blocked')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists members_status_idx on public.members (status);

-- 새 계정이 생기면 승인 대기 행을 만듭니다.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.members (user_id, email) values (new.id, new.email) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 이미 있던 계정은 승인 처리(이 스크립트를 처음 실행할 때만 의미가 있고, 이미 행이 있으면 건드리지 않음)
insert into public.members (user_id, email, status, decided_at)
  select id, email, 'approved', now() from auth.users
  on conflict (user_id) do nothing;

create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.members m where m.user_id = (select auth.uid()) and m.status = 'approved');
$$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

-- 1) 아이 프로필 ---------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 12),
  created_at timestamptz not null default now()
);
create index if not exists profiles_owner_idx on public.profiles (owner_id);

-- 2) 프로필별 학습 진행과 설정 ---------------------------------------------------
create table if not exists public.profile_state (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  progress   jsonb not null default '{}'::jsonb check (pg_column_size(progress) < 65536),
  settings   jsonb not null default '{}'::jsonb check (pg_column_size(settings) < 4096),
  updated_at timestamptz not null default now()
);

-- 3) 프로필별 풀이 기록 ----------------------------------------------------------
create table if not exists public.attempts (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  played_at  timestamptz not null default now(),
  mode       text not null check (mode in ('practice', 'challenge')),
  kind       text not null check (kind in ('mul', 'as', 'ml')),   -- 구구단 / 덧셈·뺄셈 / 곱셈
  op         text not null check (op in ('*', '+', '-', 'x')),
  level      int,
  a          int not null,
  b          int not null,
  correct    boolean not null,
  first_try  boolean not null,        -- 틀려서 다시 나온 문제가 아니라 처음 나온 문제인지
  timed_out  boolean not null default false,
  answer     int,                     -- 시간이 끝나 답을 못 냈으면 null
  elapsed_ms int
);
create index if not exists attempts_profile_time_idx on public.attempts (profile_id, played_at desc);

-- 4) 접근 제어 ------------------------------------------------------------------
alter table public.members       enable row level security;
alter table public.profiles      enable row level security;
alter table public.profile_state enable row level security;
alter table public.attempts      enable row level security;

-- 프로필 소유 여부와 개수는 RLS를 건너뛰는 함수로 확인해, 정책끼리 서로 꼬이지 않게 합니다.
create or replace function public.owns_profile(pid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = pid and p.owner_id = (select auth.uid())
  ) and public.is_approved();
$$;

create or replace function public.my_profile_count()
returns integer
language sql stable security definer set search_path = public
as $$
  select count(*)::int from public.profiles where owner_id = (select auth.uid());
$$;

revoke all on function public.owns_profile(uuid)  from public, anon;
revoke all on function public.my_profile_count()  from public, anon;
grant execute on function public.owns_profile(uuid)  to authenticated;
grant execute on function public.my_profile_count()  to authenticated;

-- Supabase는 새 테이블에 anon/authenticated 권한을 기본으로 넓게 줍니다. 먼저 모두 거두고 필요한 것만 다시 줍니다.
-- 로그인하지 않은 요청(anon)은 테이블에 아예 손댈 수 없고, 풀이 기록은 읽기·추가만 됩니다.
revoke all on public.members, public.profiles, public.profile_state, public.attempts from anon, authenticated;
-- members 는 본인 행 읽기만 됩니다. 승인·차단은 대시보드(SQL Editor)에서만 합니다.
grant select on public.members to authenticated;
grant select, insert, update, delete on public.profiles      to authenticated;
grant select, insert, update, delete on public.profile_state to authenticated;
grant select, insert                 on public.attempts      to authenticated;

-- 정책: 다시 실행해도 되도록 지우고 만듭니다.
drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;

create policy profiles_select on public.profiles for select to authenticated
  using (owner_id = (select auth.uid()) and public.is_approved());
-- 한 계정에 프로필은 최대 6개까지
create policy profiles_insert on public.profiles for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.is_approved() and public.my_profile_count() < 6);
create policy profiles_update on public.profiles for update to authenticated
  using (owner_id = (select auth.uid()) and public.is_approved()) with check (owner_id = (select auth.uid()) and public.is_approved());
create policy profiles_delete on public.profiles for delete to authenticated
  using (owner_id = (select auth.uid()) and public.is_approved());

drop policy if exists state_all on public.profile_state;
create policy state_all on public.profile_state for all to authenticated
  using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));

drop policy if exists attempts_select on public.attempts;
drop policy if exists attempts_insert on public.attempts;
create policy attempts_select on public.attempts for select to authenticated
  using (public.owns_profile(profile_id));
create policy attempts_insert on public.attempts for insert to authenticated
  with check (public.owns_profile(profile_id));

-- 5) 천만냥냥 음성 (비공개 버킷) ----------------------------------------------
-- 저작권이 있는 음성 파일은 공개 저장소나 정적 호스팅에 두지 않고, 승인된 사용자만 읽을 수 있는 비공개 버킷에 둡니다.
-- mp3는 대시보드 Storage > protected-assets 의 voice/v1/nyang/ 아래에 올립니다. 쓰기 정책은 만들지 않아서 업로드는 관리자만 할 수 있습니다.
insert into storage.buckets (id, name, public) values ('protected-assets', 'protected-assets', false)
  on conflict (id) do nothing;

drop policy if exists protected_assets_select on storage.objects;
create policy protected_assets_select on storage.objects for select to authenticated
  using (bucket_id = 'protected-assets' and public.is_approved());

-- 6) 파닉스 풀이 기록과 대시보드 ------------------------------------------------
-- 파닉스 놀이터의 답 하나하나를 기록합니다(attempts 와 같은 방식). attempts 는 두 수(a, b)와 연산이 필요해서 따로 둡니다.
create table if not exists public.ph_attempts (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  played_at  timestamptz not null default now(),
  stage      int not null,
  game       text not null check (game in ('A', 'B', 'C', 'D')),   -- 소리 고르기 / 단어 만들기 / 소리 합치기 / 사이트 워드
  item       text not null check (char_length(item) <= 40),         -- 소리 id 또는 단어
  correct    boolean not null,
  first_try  boolean not null                                       -- 틀려서 다시 나온 문제가 아니라 처음 나온 문제인지
);
create index if not exists ph_attempts_profile_time_idx on public.ph_attempts (profile_id, played_at desc);

alter table public.ph_attempts enable row level security;
revoke all on public.ph_attempts from anon, authenticated;
grant select, insert on public.ph_attempts to authenticated;

drop policy if exists ph_attempts_select on public.ph_attempts;
drop policy if exists ph_attempts_insert on public.ph_attempts;
create policy ph_attempts_select on public.ph_attempts for select to authenticated
  using (public.owns_profile(profile_id));
create policy ph_attempts_insert on public.ph_attempts for insert to authenticated
  with check (public.owns_profile(profile_id));

-- 대시보드용 집계. 하루 x 놀이터 x 모드별 풀이 수를 한 번에 돌려줍니다.
--   n: 푼 문제(기록 수) / c: 맞힌 문제 / f: 처음 나온 문제 수 / fc: 처음 나온 문제 중 맞힌 수
-- security invoker 라서 위의 RLS 가 그대로 적용됩니다. 로그인한 본인 계정의 프로필이 아니면 빈 결과가 나옵니다.
-- 날짜는 p_tz(브라우저의 시간대) 기준으로 나눕니다.
create or replace function public.dashboard_activity(p_profile uuid, p_days int default 200, p_tz text default 'Asia/Seoul')
returns jsonb
language sql stable set search_path = public
as $$
  with allr as (
    select played_at, kind, mode, correct, first_try from public.attempts where profile_id = p_profile
    union all
    select played_at, 'ph'::text, 'play'::text, correct, first_try from public.ph_attempts where profile_id = p_profile
  ),
  daily as (
    select (played_at at time zone p_tz)::date as d, kind, mode,
           count(*)::int as n,
           (count(*) filter (where correct))::int as c,
           (count(*) filter (where first_try))::int as f,
           (count(*) filter (where first_try and correct))::int as fc
    from allr
    where played_at >= now() - make_interval(days => greatest(p_days, 1) + 1)
      and (played_at at time zone p_tz)::date >= (now() at time zone p_tz)::date - greatest(p_days, 1)
    group by 1, 2, 3
  ),
  tot as (
    select kind, count(*)::int as n, (count(*) filter (where correct))::int as c from allr group by kind
  )
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'k', kind, 'm', mode, 'n', n, 'c', c, 'f', f, 'fc', fc) order by d, kind, mode) from daily), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('k', kind, 'n', n, 'c', c)) from tot), '[]'::jsonb),
    'first_at', (select min(played_at) from allr),
    'last_at', (select max(played_at) from allr)
  );
$$;
revoke all on function public.dashboard_activity(uuid, int, text) from public, anon;
grant execute on function public.dashboard_activity(uuid, int, text) to authenticated;
