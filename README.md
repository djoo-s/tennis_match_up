# 토요 테니스 클럽 - GitHub Pages + Supabase 배포본

이 버전은 기존 단일 HTML 앱을 다음 구조로 바꾸는 것을 전제로 합니다.

- 프론트: GitHub Pages
- DB/Auth: Supabase
- 일반 참가자: Supabase Anonymous Sign-In
- 관리자: Supabase Email/Password Auth
- 자동 대진표: Supabase Edge Function
- 매주 토요일 16:00 KST: Supabase Cron
- 과거 매칭: matches 테이블의 이전 세션 데이터를 사용

## 파일

- `index.html` : 웹 화면 + 참가 신청 + 결과 표시
- `config.example.js` : Supabase 프로젝트 설정 예시
- `supabase/schema.sql` : DB/RLS 초기화
- `supabase/cron.sql` : 토요일 16:00 자동 생성 Cron
- `supabase/functions/generate-match/index.ts` : 서버 대진표 생성 함수
- `supabase/config.toml` : Edge Function 설정

## 주의

`SERVICE_ROLE_KEY`와 `CRON_SECRET`은 GitHub에 올리면 안 됩니다.
`config.js`에는 브라우저 공개용 Supabase URL + Publishable Key만 넣습니다.

## 1. Supabase 프로젝트

1. Supabase에서 새 프로젝트 생성
2. Authentication > Sign In / Providers에서 Anonymous Sign-Ins 활성화
3. Email Provider 활성화
4. SQL Editor에서 `supabase/schema.sql` 실행
5. Authentication > Users > Add user로 관리자 이메일/비밀번호 계정 생성
6. 방금 만든 관리자 UUID와 이메일을 이용하여 SQL 실행:

```sql
insert into public.admins(user_id, email)
values ('ADMIN_USER_UUID', 'admin@example.com');
```

## 2. 클라이언트 설정

`config.example.js`를 `config.js`로 복사하고 다음 값을 입력:

- `SUPABASE_URL`: Supabase Project URL
- `SUPABASE_PUBLISHABLE_KEY`: Settings > API Keys의 Publishable key

`config.js`는 `.gitignore`에 들어 있으므로 GitHub에 올리지 않아도 됩니다.

## 3. Edge Function

Supabase CLI로 로그인 후 프로젝트를 연결하고 아래 secret을 등록합니다.

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set SUPABASE_SECRET_KEY="YOUR_SERVICE_ROLE_KEY"
supabase secrets set CRON_SECRET="LONG_RANDOM_SECRET"
supabase functions deploy generate-match
```

서비스 롤 키는 절대 소스 코드나 GitHub 파일에 넣지 않습니다.

## 4. Cron

`supabase/cron.sql`의 `YOUR_PROJECT_REF`와 `REPLACE_WITH_LONG_RANDOM_CRON_SECRET`을 실제 값으로 바꾼 뒤 SQL Editor에서 실행합니다.

Supabase DB는 UTC를 기본 시간대로 사용하므로 `0 7 * * 6`은 토요일 16:00 KST입니다.

## 5. GitHub Pages

1. GitHub Repository 생성
2. `index.html`, `config.js` 등을 push
3. Repository Settings > Pages
4. Source를 `Deploy from a branch`
5. `main` / `/ (root)` 선택
6. 저장
7. 생성된 `https://USERNAME.github.io/REPOSITORY/` 주소를 사용

## 6. Supabase Auth URL

Supabase Dashboard > Authentication > URL Configuration에서

- Site URL: GitHub Pages 주소

를 설정합니다.

## 운영 흐름

관리자가 최초 1회 세션 생성 -> 참가자들이 신청 -> 토요일 16:00 Cron -> Edge Function이 현재 참가자 + 최근 과거 매칭을 조회 -> 대진 계산 -> schedules/matches 저장 -> 다음 주 세션을 자동 생성.

매칭 회피는 최근 12개 세션을 대상으로 하며, 최근일수록 패널티가 큽니다. 같은 4명 전체 재대결은 더 큰 패널티를 주고, 사람이 부족하면 기존 조합도 허용합니다.
