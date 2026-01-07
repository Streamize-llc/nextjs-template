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
- Applies to all routes except static files and images

**Provider** (`src/utils/supabase/provider.tsx`):
- Wraps the app in src/app/layout.tsx
- Auto-refreshes router on `SIGNED_IN` auth events
- Hooks:
  - `useSupabase()` - Returns Supabase client or `null` if not configured
  - `useSupabaseRequired()` - Returns Supabase client or throws if not configured

**Important:** All `createClient()` functions return `null` if environment variables are missing. This allows the app to run without Supabase for local development. Always handle the null case or use `useSupabaseRequired()` when Supabase is required.

### Modal System

Uses a layered modal architecture based on shadcn/ui Dialog (Radix UI):

**Base Layer** (`src/components/ui/dialog.tsx`):
- Raw shadcn/ui Dialog primitives
- Full accessibility support (focus trap, ESC key, aria attributes)

**Application Layer** (`src/components/modals/`):
- `BaseModal` - Configurable wrapper with size variants (sm/md/lg/xl/full), title, description, footer
- `ConfirmModal` - Confirmation dialog with confirm/cancel buttons, loading state, destructive variant
- `AlertModal` - Simple alert with single confirm button

Usage:
```tsx
import { BaseModal, ConfirmModal, AlertModal } from '@/components/modals';
```

### Configuration Pattern

Config files in `src/config/` manage non-sensitive application settings:
- `client.ts` - Client-side config (exposed to browser)
- `server.ts` - Server-only config with `import 'server-only'` guard

**Usage:**
- Client: `import { clientConfig } from '@/config'`
- Server: `import { serverConfig } from '@/config/server'`

**Important:** Supabase credentials are managed via environment variables directly (not in config files) for security.

### Import Aliases

TypeScript configured with `@/*` pointing to `src/*`

### UI Components

Uses shadcn/ui pattern with components in `src/components/ui/`. Utility function `cn()` in `src/lib/utils.ts` combines clsx and tailwind-merge for className management.

### Security Headers

Security headers are configured in `next.config.ts`:
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- X-XSS-Protection: 1; mode=block

### Environment Variables

Required environment variables (create `.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anonymous key
- `NEXT_PUBLIC_GAID` - Google Analytics ID
- `SUPABASE_DB_PASSWORD` - Database password (for Supabase CLI commands)

## Key Implementation Details

### Authentication Flow
When implementing auth features, always use the appropriate Supabase client:
- Server Actions/Components: import from `@/utils/supabase/server`
- Client Components: import from `@/utils/supabase/client`
- Never mix client and server clients

### Type Generation
After modifying Supabase schema, run `npm run db:types` to regenerate TypeScript types at `src/utils/supabase/schema.type.ts`

### Middleware Behavior
The middleware refreshes user sessions on every request. If implementing protected routes, extend `updateSession()` in src/utils/supabase/middleware.ts.
