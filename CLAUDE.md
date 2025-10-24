# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 15 template with Supabase integration, using the App Router architecture. Uses TypeScript, Tailwind CSS, and shadcn/ui components. Google Analytics is integrated via @next/third-parties.

## Development Commands

### Core Development
- `npm run dev` - Start development server at http://localhost:3000
- `npm run build` - Production build
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

### Supabase Local Development
- `npm run supabase:start` - Start local Supabase instance
- `npm run supabase:stop` - Stop local Supabase instance
- `npm run supabase:status` - Check Supabase status

### Database Management
- `npm run db:new <migration_name>` - Create new migration
- `npm run db:reset` - Reset local database
- `npm run db:push` - Push migrations to remote
- `npm run db:pull` - Pull schema from remote
- `npm run db:diff` - Generate diff for schema changes
- `npm run db:link` - Link to Supabase project (replace [project_id] first)
- `npm run db:types` - Generate TypeScript types from Supabase schema (replace [project_id] first)

**Important:** Before using `db:link` or `db:types`, replace `[project_id]` in package.json with actual Supabase project ID.

## Architecture

### Supabase Integration Pattern

The project uses Supabase SSR (@supabase/ssr) with separate client configurations for different contexts:

**Server Components** (`src/utils/supabase/server.ts`):
- Use `createClient()` from `@/utils/supabase/server`
- Async function that reads cookies via Next.js `cookies()`
- Handles session management server-side

**Client Components** (`src/utils/supabase/client.ts`):
- Use `createClient()` from `@/utils/supabase/client`
- Browser-based client using `createBrowserClient`
- For client-side auth and data fetching

**Middleware** (`src/utils/supabase/middleware.ts` + `src/middleware.ts`):
- Automatically refreshes auth tokens on every request
- The `updateSession()` function maintains user sessions
- Applies to all routes except static files and images (see matcher in src/middleware.ts:9-11)

**Provider** (`src/utils/supabase/provider.tsx`):
- Wraps the app in src/app/layout.tsx:34
- Provides Supabase context throughout the application

### Import Aliases

TypeScript configured with `@/*` pointing to `src/*` (see tsconfig.json:22-23)

### UI Components

Uses shadcn/ui pattern with components in `src/components/ui/`. Utility function `cn()` in `src/lib/utils.ts` combines clsx and tailwind-merge for className management.

### Environment Variables

Required environment variables (create `.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anonymous key
- `NEXT_PUBLIC_GAID` - Google Analytics ID

## Key Implementation Details

### Authentication Flow
When implementing auth features, always use the appropriate Supabase client:
- Server Actions/Components: import from `@/utils/supabase/server`
- Client Components: import from `@/utils/supabase/client`
- Never mix client and server clients

### Type Generation
After modifying Supabase schema, run `npm run db:types` to regenerate TypeScript types at `src/utils/supabase/schema.type.ts`

### Middleware Behavior
The middleware refreshes user sessions on every request. If implementing protected routes, use the already-configured middleware pattern in src/middleware.ts and extend `updateSession()` as needed.
- 환경변수에 SUPABASE_DB_PASSWORD 라는 변수를 추가해야 하는 상황은 supabase 관련 명령어에서 DB 제어 명령어에서 해당 환경변수가 설정이 되어있어야해