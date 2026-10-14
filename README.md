This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Billing (Paddle or Polar)

Subscriptions and one-time purchases are built in, through **Paddle or Polar** (merchants of record): `/pricing`, `/billing`, signed webhooks, tables with Row Level Security, and a `getEntitlement(supabase, userId)` helper for the rest of your app. You pick the provider per project with `BILLING_PROVIDER=paddle|polar`, and you can switch later without touching anybody who has already paid. It stays off until you configure it.

```bash
# 1. edit your plans in src/config/billing.ts, apply the migration (npm run db:reset), fill .env.local from .env.example
# Paddle:
npm run paddle:catalog -- --write      # creates the products and prices in Paddle (sandbox) from that file
npm run paddle:webhook -- https://<your-tunnel>/api/webhooks/paddle --write
npm run paddle:check                   # what is configured, what is missing
# Polar:
npm run polar:catalog                  # lists the products to create in the Polar dashboard; paste their ids into .env.local
npm run polar:webhook -- https://<your-tunnel>/api/webhooks/polar --write
npm run polar:check                    # what is configured, what is missing, and whether each product matches the file
# Both:
npm run billing:check                  # which provider takes new checkouts, and is each one ready
```

The full guide (choosing, switching, the go-live checklists, troubleshooting) is in [BILLING.md](./BILLING.md).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
