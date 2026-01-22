# E2E Testing

Playwright + 로컬 Supabase를 사용한 E2E 테스트 환경입니다.

## 핵심 원칙

> **각 테스트는 자신의 데이터를 생성하고, 테스트 후 자동으로 정리한다.**

- ✅ 테스트 격리 보장
- ✅ 병렬 실행 가능
- ✅ 테스트 간 데이터 오염 없음

## 요구사항

- Docker (로컬 Supabase 실행용)

## 명령어

```bash
# E2E 테스트 실행
npm run test:e2e

# UI 모드로 실행
npm run test:e2e:ui

# 브라우저 보이게 실행
npm run test:e2e:headed

# 디버그 모드
npm run test:e2e:debug

# 테스트 리포트 보기
npm run test:e2e:report
```

## 폴더 구조

```
e2e/
├── fixtures/
│   └── index.ts           # 커스텀 fixtures (testData, supabaseAdmin 등)
├── pages/                 # Page Object Models
│   ├── base.page.ts
│   └── home.page.ts
├── tests/                 # 테스트 파일 (도메인별)
│   ├── auth/
│   │   └── user.spec.ts
│   └── smoke/
│       └── health.spec.ts
├── utils/
│   ├── test-data.ts       # TestDataFactory (데이터 생성/정리)
│   └── test-helpers.ts    # 기타 헬퍼
├── global-setup.ts        # Supabase 시작 + 마이그레이션 적용
└── global-teardown.ts
```

## 테스트 작성 가이드

### 기본 구조

```typescript
import { test, expect } from '../../fixtures';

test.describe('기능명', () => {
  test('테스트 케이스', async ({ testData, page }) => {
    // 1. Arrange - 테스트 데이터 생성
    const user = await testData.createUser();

    // 2. Act - 테스트 실행
    await page.goto('/login');
    // ...

    // 3. Assert - 검증
    expect(something).toBe(expected);

    // Cleanup은 자동! (testData fixture가 처리)
  });
});
```

### 사용 가능한 Fixtures

| Fixture | 설명 |
|---------|------|
| `page` | Playwright 기본 Page 객체 |
| `homePage` | HomePage Page Object |
| `testData` | **테스트 데이터 팩토리** (자동 정리) |
| `supabaseAdmin` | Supabase 서비스 클라이언트 |

### TestDataFactory 사용법

```typescript
test('사용자 테스트', async ({ testData }) => {
  // 사용자 생성 (테스트 후 자동 삭제)
  const user = await testData.createUser({
    email: testData.generateEmail('prefix'),  // prefix-123456-abc123@test.local
    password: testData.generatePassword(),    // TestPass_xxxxxxxx!
    metadata: { name: 'Test User' },
  });

  // 테이블 레코드 생성 (테스트 후 자동 삭제)
  const record = await testData.createRecord('posts', {
    title: 'Test Post',
    user_id: user.id,
  });

  // 커스텀 정리 로직 등록
  testData.onCleanup(async () => {
    // 추가 정리 작업
  });
});
```

### Page Object 추가하기

1. `e2e/pages/`에 새 페이지 파일 생성:

```typescript
// e2e/pages/login.page.ts
import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class LoginPage extends BasePage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByLabel('이메일');
    this.passwordInput = page.getByLabel('비밀번호');
    this.submitButton = page.getByRole('button', { name: '로그인' });
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
```

2. `e2e/fixtures/index.ts`에 fixture 추가:

```typescript
import { LoginPage } from '../pages/login.page';

type Fixtures = {
  // ... 기존
  loginPage: LoginPage;
};

export const test = base.extend<Fixtures>({
  // ... 기존
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
});
```

## 실행 흐름

```
npm run test:e2e
    │
    ▼
[global-setup.ts]
    ├─ Docker 체크
    ├─ Supabase 시작 (이미 실행 중이면 스킵)
    └─ 마이그레이션 적용
    │
    ▼
[테스트 실행]
    각 테스트:
    ├─ testData.createUser() → 데이터 생성
    ├─ 테스트 로직 실행
    └─ testData.cleanup() → 자동 정리 (fixture 종료 시)
    │
    ▼
[global-teardown.ts]
    └─ (Supabase는 계속 실행 유지)
```

## 환경 설정

### .env.test

```env
E2E_BASE_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

`playwright.config.ts`에서 dotenv로 자동 로드됩니다.

## Supabase 로컬 관리

```bash
# 상태 확인
npm run supabase:status

# 수동 시작/중지
npm run supabase:start
npm run supabase:stop

# DB 완전 초기화 (마이그레이션 + seed 재적용)
npm run db:reset
```

### 데이터 유지 관련

| 상황 | 데이터 |
|------|--------|
| `supabase stop` | ✅ 유지됨 |
| 맥 재부팅 | Supabase 꺼짐, 데이터는 유지 |
| `supabase start` (다시) | ✅ 이전 데이터 그대로 |
| `db:reset` | ❌ 초기화 |

## CI (GitHub Actions)

`.github/workflows/e2e.yml`에 CI 워크플로우가 설정되어 있습니다.

```yaml
# PR이나 main push 시 자동 실행
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

## 팁

### 테스트 디버깅

```bash
# 특정 테스트만 실행
npm run test:e2e -- --grep "테스트명"

# 특정 파일만 실행
npm run test:e2e -- e2e/tests/auth/user.spec.ts

# 디버그 모드 (브라우저 + 스텝 실행)
npm run test:e2e:debug
```

### 데이터 확인

```bash
# Supabase Studio에서 DB 직접 확인
# http://127.0.0.1:54323 (supabase start 후)
```
