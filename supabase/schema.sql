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
  );
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
revoke all on public.profiles, public.profile_state, public.attempts from anon, authenticated;
grant select, insert, update, delete on public.profiles      to authenticated;
grant select, insert, update, delete on public.profile_state to authenticated;
grant select, insert                 on public.attempts      to authenticated;

-- 정책: 다시 실행해도 되도록 지우고 만듭니다.
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;

create policy profiles_select on public.profiles for select to authenticated
  using (owner_id = (select auth.uid()));
-- 한 계정에 프로필은 최대 6개까지
create policy profiles_insert on public.profiles for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.my_profile_count() < 6);
create policy profiles_update on public.profiles for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy profiles_delete on public.profiles for delete to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists state_all on public.profile_state;
create policy state_all on public.profile_state for all to authenticated
  using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));

drop policy if exists attempts_select on public.attempts;
drop policy if exists attempts_insert on public.attempts;
create policy attempts_select on public.attempts for select to authenticated
  using (public.owns_profile(profile_id));
create policy attempts_insert on public.attempts for insert to authenticated
  with check (public.owns_profile(profile_id));
