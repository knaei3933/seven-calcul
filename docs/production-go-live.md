# 파우치 견적·필름 발주 시스템 실운영 전환 절차

이 문서는 실행 절차서입니다. 실제 전환은 관련자가 전환 일시를 확정한 뒤에만 실행합니다.

- 대상: `seven-calcul`
- Production URL: `https://seven-calcul.vercel.app`
- 브랜치: `main`
- DB: Neon PostgreSQL 통일
- 고객 언어: 일본어 고정
- 2026-10-21 기준: Production에 아직 `FILM_PRACTICE_TO`가 있어 외부 메일이 연습 주소로 우회될 수 있음

## 0. 현재 확인된 전환 전 필수 항목

Production 환경변수 기준으로 다음 항목이 남아 있습니다.

| 항목 | 현재 상태 | 전환 전 조치 |
| --- | --- | --- |
| `MAIL_RECIPIENT_OVERRIDE` | 미설정 | 유지 |
| `MAIL_DRY_RUN` | 미설정 | 유지 |
| `FILM_PRACTICE_TO` | 설정됨 | 실운영 전환 시 삭제 |
| `SMTP_PASSWORD` | 설정됨 | 필름 발주 관련 메일에 사용 |
| `SMTP_PASS` | 미설정 | 견적 PDF 메일 전송 API가 요구 |

특히 `SMTP_PASS`가 없으면 견적 PDF 첨부 메일은 `smtp_not_configured`로 실패합니다. 코드 통일 전에는 `SMTP_PASSWORD`와 동일한 값을 `SMTP_PASS`에도 설정해야 합니다.

## 1. 전환 전 체크리스트

### 1.1 소스와 빌드

```bash
git switch main
git pull origin main
git status --short
npm run typecheck
npm run lint
npm test
npm run build
```

모두 통과하면 배포 예정 커밋에 태그를 남깁니다.

```bash
git tag go-live-YYYYMMDD
git push origin go-live-YYYYMMDD
```

작업 디렉터리에 커밋되지 않은 변경이 남으면 전환을 진행하지 않습니다.

### 1.2 Vercel Production 환경변수 감사

```bash
vercel env ls production
```

필수 항목:

```text
DATABASE_URL
FILM_CUSTOMER_DESIGN_FOLDER_ID
FILM_DELIVERY_DOCUMENT_FOLDER_ID
FILM_EXTERNAL_TOKEN_SECRET
QUOTATION_APPROVAL_SECRET
AUTH_SECRET
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_PASSWORD
MAIL_FROM
ADMIN_EMAIL
ADMIN_NAME
ADMIN_PASSWORD
```

권장 항목:

```text
FILM_DESIGN_TO
FILM_RECEIVING_FOLDER_ID
FILM_PROOF_FOLDER_ID
FILM_SUPPLIER_A_EMAIL
FILM_SUPPLIER_B_EMAIL
FILM_ETA_SECRET
```

비밀값은 셸 히스토리에 남기지 말고 Vercel Dashboard 또는 stdin으로 설정합니다.

```bash
openssl rand -base64 48 | tr -d '\n' | vercel env add FILM_ETA_SECRET production --force --yes
```

기존 값을 교체할 때:

```bash
printf '%s' "$VALUE" | vercel env add NAME production --force --yes
```

`$VALUE`에는 실값을 사용하고, 문서나 셸 히스토리에 실제 비밀을 남기지 않습니다.

### 1.3 이메일 설정

현재 코드는 두 가지 메일 전송 경로를 사용합니다.

| 기능 | 모듈 | 필수 변수 |
| --- | --- | --- |
| 견적 PDF 첨부 메일 | `src/lib/mail-sender.ts` | `SMTP_PASS` |
| 필름 발주 관련 메일 | `src/lib/mailer.ts` | `SMTP_PASSWORD` |

코드 통일 전에는 두 변수를 같은 SMTP 비밀번호로 설정합니다.

실운영 전환 시 다음 테스트 전용 우회 설정을 제거합니다.

```bash
vercel env rm FILM_PRACTICE_TO production --yes
vercel env rm MAIL_RECIPIENT_OVERRIDE production --yes
vercel env rm MAIL_DRY_RUN production --yes
```

존재하지 않는 항목은 건너뛰면 됩니다. 환경변수 삭제 후에는 반드시 재배포합니다.

### 1.4 Google Drive 폴더

Production 전용 폴더를 사용합니다.

```text
Pouch Customer Designs - Production
Pouch Delivery Notes - Production
```

확인 항목:

- OAuth 계정이 해당 폴더에 업로드 가능한지
- 폴더가 외부 공개되어 있지 않은지
- Preview / 연습 폴더와 섞이지 않았는지
- 입稿·교정 폴더도 운영 전용으로 분리할 경우 `FILM_RECEIVING_FOLDER_ID`, `FILM_PROOF_FOLDER_ID`를 명시했는지

### 1.5 Neon DB

Hosted runtime에서는 SQLite fallback이 금지되어 있습니다.

확인 항목:

- `DATABASE_URL`이 Neon PostgreSQL URL인지
- 호스트가 `*.neon.tech`인지
- Production DB에 실무 데이터 외 테스트 주문/견적이 없는지
- 전환 직전 Neon backup 또는 PITR 기준점이 확보되어 있는지

필요하면 백업을 생성합니다.

```bash
pg_dump "$DATABASE_URL" > backup-before-go-live-YYYYMMDD.sql
```

`$DATABASE_URL`에 실제 연결 문자열을 직접 넣지 말고, 임시 환경변수 또는 보안 저장소 값을 사용합니다.

## 2. Production 배포

Vercel 환경변수는 기존 deployment에 자동 반영되지 않습니다. 삭제/추가/수정 후 반드시 재배포합니다.

```bash
vercel deploy --prod --yes
```

배포 후 alias를 확인합니다.

```bash
vercel ls seven-calcul --prod
```

## 3. 배포 후 스모크 테스트

### 3.1 설정 확인

```bash
curl -fsS https://seven-calcul.vercel.app/api/film-orders/delivery-upload/check
```

기대 응답:

```json
{
  "driveConfigured": true,
  "folderConfigured": true,
  "allowedExtensions": [".pdf"],
  "maxBytes": 15728640
}
```

로그인 페이지도 확인합니다.

```bash
curl -I https://seven-calcul.vercel.app/login
```

기대 상태는 `200`입니다.

### 3.2 견적 흐름

1. 실제 계정으로 로그인
2. 시뮬레이터에서 견적 생성
3. 고객 코드, 고객 이메일, SKU명 입력
4. A4 PDF 발행
5. Kim `kim@kanei-trade.co.jp` 내부 승인
6. PDF 첨부 메일 발송
7. 실제 메일함 수신 확인
8. 고객 승인 링크로 승인
9. History에서 성약 상태 확인
10. 필름 발주 관리 자동 생성 확인

확인 항목:

- PDF URL이 `200`과 실제 PDF bytes를 반환하는지
- 메일 실제 수신자가 운영 주소인지
- 첨부 PDF가 정상 개봉되는지
- 승인 토큰이 만료/변조 조건에서 거부되는지

### 3.3 필름 발주 흐름

1. 필름 발주 관리에서 대상 건을 엽니다.
2. 샘플 지급량과 본 생산 벌크 사용량이 구분되는지 확인합니다.
3. 샘플 벌크 요청, 수령, 확인을 진행합니다.
4. 고객 디자인 입고를 요청합니다.
5. 고객이 전용 URL로 AI/PDF를 업로드합니다.
6. 디자이너 메일 언어가 조달 경로와 일치하는지 확인합니다.
   - digital / K: 한국어
   - Y: 일본어
7. 입稿 데이터를 등록합니다.
8. 공급사가 교정 데이터를 제출합니다.
9. 세븐화학 고객 교정 승인을 진행합니다.
10. 최종 승인합니다.
11. 발주서 URL을 발송합니다.
12. 공급사가 로그인 없이 발주서 전용 페이지를 엽니다.

### 3.4 납기·납품·수령 흐름

1. 공급사가 ETA 페이지에서 납기 전망을 입력합니다.
2. 납품서 PDF를 Drive 전용 폴더로 업로드합니다.
3. 출하일, 운송사, 운송장 번호를 등록합니다.
4. 세븐화학에 출하 알림이 발송되는지 확인합니다.
5. 납품일을 등록합니다.
6. 세븐화학에 납품 완료 알림이 발송되는지 확인합니다.
7. 세븐화학이 수령을 확인합니다.
8. 공급사에 수령 확인 알림이 발송되는지 확인합니다.
9. 필름 발주 이력에 delivery / token / email 이벤트가 남는지 확인합니다.

### 3.5 링크 및 파일 분리 확인

- 공급사 메일에 raw Drive 폴더 URL이 없는지
- 공급사 링크가 purpose-scoped token URL만 있는지
- 다른 발주건 파일이 보이지 않는지
- 변조/만료/무효 토큰이 403 또는 404로 거부되는지
- 내부 전용 `/film-orders` URL이 외부 메일에 없는지

## 4. 실운영 전환 판정

다음이 모두 `OK`일 때만 실운영을 선언합니다.

```text
[ ] main build / tests 성공
[ ] Production deployment 성공
[ ] Neon URL 및 migration 상태 확인
[ ] Drive Production 폴더 확인
[ ] SMTP_PASS / SMTP_PASSWORD 확인
[ ] FILM_PRACTICE_TO 삭제
[ ] MAIL_RECIPIENT_OVERRIDE 미설정
[ ] MAIL_DRY_RUN 미설정
[ ] 견적 PDF 메일 실송신 성공
[ ] 필름 관련 메일 실송신 성공
[ ] 견적 → 성약 → 발주 자동 생성 성공
[ ] 입稿 → 교정 → 승인 성공
[ ] 발주서 전용 페이지 정상 표시
[ ] 납품서 PDF가 전용 Drive 폴더에 저장
[ ] 출하 → 납품 → 수령 확인 성공
[ ] 감사 이벤트 정상 기록
[ ] rollback 대상 deployment URL 기록
```

## 5. Rollback

애플리케이션 문제라면 직전 정상 deployment로 되돌립니다.

```bash
vercel rollback <previous-production-deployment-url> --yes
vercel rollback status
```

원인이 환경변수라면 해당 값을 되돌린 뒤 재배포합니다.

```bash
printf '%s' "$PRACTICE_ADDRESS" | vercel env add FILM_PRACTICE_TO production --force --yes
vercel deploy --prod --yes
```

DB는 자동 rollback하지 않습니다. 입력된 실데이터는 원칙적으로 유지합니다. 데이터 삭제가 필요하면 Neon backup 또는 PITR 확보 후 관련자 승인을 받고 별도 작업으로 실행합니다.

## 6. 전환 직후 모니터링

첫 영업일은 다음 로그와 오류를 집중 확인합니다.

```text
Vercel Runtime Logs
Neon connection errors
SMTP authentication errors
Drive upload / find errors
invalid_external_token
file_not_registered
uploaded_file_mismatch
customer_email_required
supplier_destination_missing
```

문의가 오면 발주번호와 film order events로 진행 이력을 먼저 확인합니다.
