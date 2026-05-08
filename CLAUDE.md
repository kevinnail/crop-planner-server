# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is the backend API for the **Crop Planner** iOS app (`com.kevinnail.gardentracker`), available on the Apple App Store.

> **⚠️ Scope note (2026-05-07):** v1 scope is **cloud backup via Apple IAP only**. Stripe web subscriptions, the `/config/flags` endpoint, and the Next.js companion website (`/web`) are **deferred** — see `backend-starter/PLAN.md`'s `Future Work` section. The sections below that mention Stripe or the website describe the eventual system, not current scope. When in doubt, `PLAN.md`'s active slices are the source of truth.

Read `backend-starter/SPEC.md` for the full feature specification. Read `backend-starter/PLAN.md` for the implementation plan (9 vertical slices for v1).

## What This Repo Does

- **Express API** — auth, subscription webhooks (RevenueCat, Stripe), cloud sync endpoints
- **Next.js website** (`/web`) — landing page, Stripe checkout, read-only crop data dashboard, account portal

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| Auth | better-auth |
| ORM | Drizzle |
| Database | PostgreSQL (Railway add-on) |
| Payments | Stripe (web), RevenueCat (IAP bridge) |
| Website | Next.js 14 (App Router), co-located in `/web` |
| Testing | Vitest + Supertest |
| Hosting | Railway (API + DB), Vercel (website) |

## Development Commands

```bash
npm run dev          # Start Express server with hot reload (tsx watch)
npm run build        # Compile TypeScript
npm run test         # Run Vitest test suite
npm run db:generate     # Generate a SQL file from schema.ts changes (CREATE/ALTER TABLE statements)
npm run db:apply-schema # Run the generated SQL against the database (creates/alters tables)
npm run db:studio    # Open Drizzle Studio (visual DB browser)

cd web && npm run dev    # Start Next.js dev server
cd web && npm run build  # Production build
```

Run a single test file:
```bash
npm run test -- tests/health.test.ts
```

**Schema changes**: edit `src/db/schema.ts` → `npm run db:generate` (writes a diff SQL file into `drizzle/`) → review the generated SQL → `npm run db:apply-schema`. Files in `drizzle/` are generated — never hand-edit them.

## Architecture

The Express app is split across two files: `src/app.ts` sets up middleware and routes (importable for tests), and `src/server.ts` calls `app.listen` (the actual entry point). This pattern lets Supertest import the app without binding a port.

Routes map 1:1 to concerns: `health.ts`, `webhooks.ts` (RevenueCat + Stripe), `sync.ts` (cloud pull/push), `stripe.ts` (checkout), `config.ts` (feature flags). All sync routes sit behind both auth middleware and `checkSubscription` middleware.

The `/web` Next.js website is a separate npm workspace with its own `package.json`. It uses the better-auth React client (`web/lib/auth-client.ts`) to communicate with the Express API.

## Development Approach — Vertical Slices

**Always build in vertical slices.** A slice = one complete feature from database → API → tests → frontend. Never build all DB tables, then all routes, then all UI.

A slice is done only when:
1. The schema file exists and applies cleanly to the database
2. The route handles the happy path and at least one failure case
3. Tests cover both
4. Any corresponding frontend page is wired up and renders real data

## Key Behavioral Rules

- **Webhook handlers must verify signatures before processing** — no exceptions (RevenueCat: check `Authorization` header; Stripe: use `stripe.webhooks.constructEvent(rawBody, sig, secret)`)
- **All `/sync/*` routes require both auth middleware AND `checkSubscription` middleware**
- **Subscription status is sourced from the backend `subscriptions` table only** — never trust client-reported status
- **RevenueCat and the database are dual sources of truth** — a subscription is active if either confirms it
- **`ENABLE_STRIPE_EXTERNAL_LINK` is the kill switch** for Stripe web checkout — check it before the `/config` endpoint returns the flag
- **Stripe external link is US App Store users only** — storefront detection is done in the app via RevenueCat, not server-side

## Environment Variables

See `.env.example` for all required variables. Key ones:

```
DATABASE_URL=
BETTER_AUTH_SECRET=
REVENUECAT_WEBHOOK_AUTH_HEADER=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID=
ENABLE_STRIPE_EXTERNAL_LINK=true
NEXT_PUBLIC_API_URL=
```
