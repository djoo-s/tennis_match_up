# 실제 배포 순서

아래 순서대로 하면 됩니다.

## A. Supabase

1. https://supabase.com 에서 새 프로젝트 생성
2. Authentication > Providers > Anonymous Sign-Ins 활성화
3. Email Provider 활성화
4. SQL Editor에서 `supabase/schema.sql` 전체 실행
5. Authentication > Users > Add user에서 관리자 계정 생성
6. 생성된 관리자 User UUID를 복사
7. SQL Editor 실행:

```sql
insert into public.admins(user_id, email)
values ('관리자_UUID', '관리자이메일');
```

8. Project Settings > API Keys에서 Publishable Key를 확인
9. Project URL 확인
10. 로컬 프로젝트의 `config.js`에 입력

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxxxx.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..."
};
```

Publishable Key는 브라우저에 들어가도 되지만 RLS가 필수입니다. Secret Key는 절대 `config.js`나 GitHub에 넣지 않습니다.

## B. Edge Function

Supabase CLI 설치 후 터미널:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set SUPABASE_SECRET_KEY="YOUR_SERVICE_ROLE_KEY"
supabase secrets set CRON_SECRET="아주긴랜덤문자열"
supabase functions deploy generate-match
```

`YOUR_SERVICE_ROLE_KEY`는 Project Settings > API Keys의 secret/service_role 계열 키입니다. 이 키는 GitHub에 절대 올리지 않습니다.

## C. Cron

Dashboard > Integrations > Extensions에서 다음을 켭니다.

- pg_cron
- pg_net
- Vault

그 후 `supabase/cron.sql`에서 아래 두 값을 바꿉니다.

- `YOUR_PROJECT_REF`
- `REPLACE_WITH_LONG_RANDOM_CRON_SECRET`

SQL Editor에서 실행합니다.

```sql
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('REPLACE_WITH_LONG_RANDOM_CRON_SECRET', 'cron_secret');

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
```

Supabase DB는 UTC를 기본으로 권장하므로 토요일 16:00 KST는 토요일 07:00 UTC입니다.

## D. GitHub

Repository에 다음을 올립니다.

```text
index.html
config.js
.gitignore
```

`config.js`에는 Supabase URL + Publishable Key만 들어가므로 공개 저장소에 넣어도 됩니다. 단, DB RLS가 켜져 있어야 합니다.

그리고 `Settings > Pages > Deploy from a branch > main > /(root)` 선택.

## E. 보안상 절대 GitHub에 올리지 말 것

- `SUPABASE_SECRET_KEY`
- `CRON_SECRET`
- 관리자 비밀번호

Secret Key와 Cron Secret은 Supabase Edge Function의 Secret에만 등록합니다.
## F. 최초 1회 운영 시작

1. 배포된 사이트 접속
2. 관리자 로그인
3. `다음 세션 만들기`
4. 참가자들이 신청
5. 토요일 16:00에 Cron이 자동 실행
6. 대진표가 `schedules`에 저장되고 `matches`에 개별 경기가 저장됨
7. 생성 직후 다음 토요일 세션도 자동 생성됨

## G. 수동 테스트

실제 토요일까지 기다리지 않고 테스트하려면 관리자 로그인 후 `대진표 생성/재생성` 버튼을 누릅니다.

최소 4명 이상 신청되어 있어야 합니다.

## H. 과거 매칭 회피 작동 방식

서버는 현재 세션보다 이전 12개 세션의 `matches`를 읽습니다.

- 최근에 같은 두 사람이 같은 경기에서 만남 -> 높은 패널티
- 같은 파트너로 다시 묶임 -> 더 높은 패널티
- 완전히 같은 4명 재대결 -> 매우 높은 패널티
- 참가자가 적어서 피할 수 없음 -> 기존 조합을 허용
- 경기 수 균등이 먼저 깨지지 않도록 균등성도 함께 최적화

따라서 '절대 중복 금지'가 아니라 '가능한 한 중복을 줄이고, 다른 조건과 충돌하면 허용'하는 방식입니다.
