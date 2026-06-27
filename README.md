# Crop Planner Server

Backend API for the [Crop Planner](https://apps.apple.com/us/app/crop-planner/id6762229774) iOS app (`com.kevinnail.gardentracker`).

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture overview and [`backend-starter/SPEC.md`](./backend-starter/SPEC.md) / [`backend-starter/PLAN.md`](./backend-starter/PLAN.md) for the feature spec and implementation plan.

## Stack

Node.js + TypeScript, Express, Drizzle (Postgres), better-auth, Vitest + Supertest.

## Local setup

1. **Install Postgres 15+** locally and create the dev and test databases:

   ```bash
   createdb crop_planner_dev
   createdb crop_planner_test
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure env:**
   - Create `.env` with the variables listed in `backend-starter/SETUP.md` §6.
   - Create `.env.test` for tests (uses `crop_planner_test`). Both files are gitignored.

4. **Apply schema:**
   ```bash
   npm run db:generate     # regenerate SQL if schema.ts changed
   npm run db:apply-schema # apply against $DATABASE_URL
   ```

## Scripts

| Command                           | What it does                              |
| --------------------------------- | ----------------------------------------- |
| `npm run dev`                     | Start Express with hot reload (tsx watch) |
| `npm run build`                   | Compile TypeScript to `dist/`             |
| `npm start`                       | Run compiled server from `dist/`          |
| `npm test`                        | Run the Vitest suite (loads `.env.test`)  |
| `npm run typecheck`               | Type-check without emitting               |
| `npm run lint` / `lint:fix`       | ESLint over the repo                      |
| `npm run format` / `format:check` | Prettier write / check                    |
| `npm run db:generate`             | Generate SQL diff from `src/db/schema.ts` |
| `npm run db:apply-schema`         | Apply generated SQL to `$DATABASE_URL`    |
| `npm run db:studio`               | Open Drizzle Studio                       |

Run a single test file:

```bash
npm test -- tests/health.test.ts
```

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck, and tests on push and PR to `main` / `dev`.
