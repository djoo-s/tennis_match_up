-- 토요 테니스 클럽 - Supabase 초기 스키마
-- 1) Supabase SQL Editor에서 전체 실행
-- 2) pg_cron / pg_net은 Dashboard > Integrations > Extensions에서 활성화

create extension if not exists pgcrypto;

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null unique,
  status text not null default 'open' check (status in ('open','generated')),
  court_count integer not null default 2 check (court_count between 1 and 4),
  start_time text not null default '17:00',
  end_time text not null default '20:00',
  duration integer not null default 30 check (duration between 15 and 60),
  created_at timestamptz not null default now(),
  generated_at timestamptz
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 10),
  gender text not null check (gender in ('M','F')),
  level integer not null check (level between 1 and 4),
  max_games integer check (max_games is null or max_games between 1 and 12),
  start_from integer not null default 1 check (start_from between 1 and 5),
  created_at timestamptz not null default now(),
  unique (session_id, user_id)
);

create index if not exists registrations_session_created_idx
  on public.registrations(session_id, created_at);

create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.sessions(id) on delete cascade,
  generated_at timestamptz not null default now(),
  duration integer not null default 30,
  plan jsonb not null default '{}'::jsonb,
  verification jsonb not null default '{}'::jsonb,
  junk_count integer not null default 0,
  history_avoidance jsonb not null default '{}'::jsonb,
  player_stats jsonb not null default '[]'::jsonb,
  courts jsonb not null default '[]'::jsonb
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  court_no integer not null,
  slot_no integer not null,
  start_minute integer not null,
  match_type text not null check (match_type in ('mixed','men','women','junk')),
  team1_ids uuid[] not null,
  team2_ids uuid[] not null,
  player_ids uuid[] not null,
  team1_names text[] not null,
  team2_names text[] not null,
  created_at timestamptz not null default now()
);

create index if not exists matches_session_idx on public.matches(session_id);
create index if not exists matches_session_slot_idx on public.matches(session_id, slot_no, court_no);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins
    where user_id = auth.uid()
  );
$$;

-- RLS
alter table public.sessions enable row level security;
alter table public.admins enable row level security;
alter table public.registrations enable row level security;
alter table public.schedules enable row level security;
alter table public.matches enable row level security;

-- Grants: anonymous sign-in users use the authenticated role.
grant select on public.sessions to authenticated;
grant insert, update, delete on public.sessions to authenticated;
grant select on public.admins to authenticated;
grant select, insert, update, delete on public.registrations to authenticated;
grant select on public.schedules to authenticated;
grant select on public.matches to authenticated;

-- Sessions
 drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
  for select to authenticated using (true);

 drop policy if exists sessions_admin_insert on public.sessions;
create policy sessions_admin_insert on public.sessions
  for insert to authenticated
  with check (public.is_admin());

 drop policy if exists sessions_admin_update on public.sessions;
create policy sessions_admin_update on public.sessions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

 drop policy if exists sessions_admin_delete on public.sessions;
create policy sessions_admin_delete on public.sessions
  for delete to authenticated
  using (public.is_admin());

-- Admins: only a user can see its own admin row.
drop policy if exists admins_self_select on public.admins;
create policy admins_self_select on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- Registrations
 drop policy if exists registrations_select on public.registrations;
create policy registrations_select on public.registrations
  for select to authenticated using (true);

 drop policy if exists registrations_insert_own on public.registrations;
create policy registrations_insert_own on public.registrations
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.sessions s
      where s.id = session_id and s.status = 'open'
    )
  );

 drop policy if exists registrations_update_own on public.registrations;
create policy registrations_update_own on public.registrations
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

 drop policy if exists registrations_delete_own on public.registrations;
create policy registrations_delete_own on public.registrations
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Schedules / matches: public read, server/admin write.
drop policy if exists schedules_select on public.schedules;
create policy schedules_select on public.schedules
  for select to authenticated using (true);

drop policy if exists schedules_admin_insert on public.schedules;
create policy schedules_admin_insert on public.schedules
  for insert to authenticated with check (public.is_admin());

drop policy if exists schedules_admin_update on public.schedules;
create policy schedules_admin_update on public.schedules
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists schedules_admin_delete on public.schedules;
create policy schedules_admin_delete on public.schedules
  for delete to authenticated using (public.is_admin());

drop policy if exists matches_select on public.matches;
create policy matches_select on public.matches
  for select to authenticated using (true);

drop policy if exists matches_admin_insert on public.matches;
create policy matches_admin_insert on public.matches
  for insert to authenticated with check (public.is_admin());

drop policy if exists matches_admin_delete on public.matches;
create policy matches_admin_delete on public.matches
  for delete to authenticated using (public.is_admin());

-- 기본 설정 설명용 코멘트
comment on table public.sessions is '토요 테니스 클럽 주차별 세션';
comment on table public.registrations is '세션별 참가 신청';
comment on table public.schedules is '세션별 최종 대진표';
comment on table public.matches is '대진표의 개별 경기. 과거 매칭 회피 계산에 사용';
