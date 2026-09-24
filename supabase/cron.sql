-- Supabase Cron 설정
-- 1) Dashboard > Integrations > Extensions에서 pg_cron, pg_net, vault 활성화
-- 2) 아래 project_url / cron_secret을 본인 값으로 넣어 Vault에 저장
-- 3) CRON_SECRET은 32자 이상의 랜덤 문자열 권장
-- 4) Supabase DB 기본 시간대는 UTC이므로 토요일 16:00 KST = 토요일 07:00 UTC

select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co',
  'project_url'
);

select vault.create_secret(
  'REPLACE_WITH_LONG_RANDOM_CRON_SECRET',
  'cron_secret'
);

-- 기존 동일 이름 작업 제거 후 생성
select cron.unschedule(jobid)
from cron.job
where jobname = 'tennis-generate-saturday-1600';

select cron.schedule(
  'tennis-generate-saturday-1600',
  '0 7 * * 6',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/generate-match',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron')
  ) as request_id;
  $$
);

-- 확인
select jobid, jobname, schedule, active
from cron.job
where jobname = 'tennis-generate-saturday-1600';
