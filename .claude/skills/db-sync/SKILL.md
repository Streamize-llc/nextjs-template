---
name: db-sync
description: Supabase 마이그레이션 생성 후 TypeScript 타입을 재생성합니다. 데이터베이스 스키마 변경, 테이블 추가, 컬럼 수정 등 DB 작업 시 사용합니다.
---

# DB Sync

## Instructions

1. `npm run db:new <migration_name>` 실행하여 새 마이그레이션 파일 생성
2. 생성된 마이그레이션 파일 경로를 사용자에게 알려주고, SQL 작성 안내
3. SQL 작성 완료 후, `npm run db:types` 실행하여 TypeScript 타입 재생성

## 주의사항

- `db:types` 실행 전 package.json의 `[project_id]`가 실제 Supabase 프로젝트 ID로 교체되어 있어야 함
