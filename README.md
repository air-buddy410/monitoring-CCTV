# PANTAU: MVP-0 vertical slice

Multi-brand CCTV/VMS (PRD `PRD-LABS-PANTAU-002` v0.2). This repository currently contains **only MVP-0**:

> add a device manually → ONVIF probe (brand/model/firmware/capabilities) → camera list → JPEG snapshot

with authentication + tenants (Better Auth organizations), tenant isolation by **PostgreSQL RLS**, an **audit log**,
an **ONVIF method whitelist** with timeouts, and a **mock ONVIF device** so nothing needs a physical camera.

Not included (later phases): live video / go2rtc / WebRTC / TURN, WS-Discovery, agent WebSocket, NVR playback,
motion events, PWA/web UI, 2FA, Hikvision/Dahua adapters. See `docs/DECISIONS.md` for deviations from the PRD
and `docs/HASIL-CLOUD.md` for verification results and known gaps.

## Requirements

- Node.js >= 22 (PRD targets 24 LTS; `.nvmrc` says 24, verified here on 22.22)
- pnpm 10 (`corepack enable`)
- PostgreSQL >= 16 reachable locally (PRD targets 17; verified on 16.14), plus `pg_dump` on PATH (one test dumps the DB)

## Run it

```bash
pnpm install --frozen-lockfile

# 1) local DB: creates DUMMY roles pantau_owner / pantau_app and database `pantau`
pg_ctlcluster 16 main start        # or however you start PostgreSQL
pnpm db:setup                      # needs `su postgres`; see scripts/setup-local-db.sh

# 2) configuration
cp .env.example .env               # then set VAULT_KEY (see file) and export the variables, e.g.:
set -a; . ./.env; set +a
pnpm db:migrate                    # runs as pantau_owner (MIGRATION_DATABASE_URL)

# 3) mock ONVIF camera/NVR (dummy credentials dummy-admin / dummy-password), prints its port
pnpm dev:mock

# 4) API (second terminal)
pnpm build && pnpm start           # or: pnpm dev:api
```

OpenAPI JSON: `GET http://localhost:3000/docs/json` (also committed at `docs/openapi.json`; regenerate with `pnpm openapi:export`).

### Try the flow with curl

Better Auth rejects cookie-bearing requests without an `Origin` header (CSRF protection), so send one.

```bash
H1='content-type: application/json'; H2='Origin: http://localhost:3000'; J=/tmp/pantau.jar
curl -c $J -H "$H1" -H "$H2" -X POST localhost:3000/api/auth/sign-up/email \
     -d '{"email":"demo@example.test","password":"Dummy-Demo-Pass-123","name":"Demo"}'
ORG=$(curl -s -b $J -c $J -H "$H1" -H "$H2" -X POST localhost:3000/api/auth/organization/create \
     -d '{"name":"Demo Org","slug":"demo-org"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -b $J -c $J -H "$H1" -H "$H2" -X POST localhost:3000/api/auth/organization/set-active -d "{\"organizationId\":\"$ORG\"}"
SITE=$(curl -s -b $J -H "$H1" -H "$H2" -X POST localhost:3000/v1/sites -d '{"name":"Demo site"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
# MOCK_PORT = port printed by `pnpm dev:mock`
curl -b $J -H "$H1" -H "$H2" -X POST localhost:3000/v1/devices \
     -d "{\"siteId\":\"$SITE\",\"name\":\"Mock NVR\",\"host\":\"127.0.0.1\",\"port\":$MOCK_PORT,\"username\":\"dummy-admin\",\"password\":\"dummy-password\"}"
curl -b $J -H "$H2" -X POST localhost:3000/v1/cameras/<cam_id>/snapshot -o snap.jpg
curl -b $J localhost:3000/v1/audit
```

## Endpoints

| | |
|---|---|
| `/api/auth/*` | Better Auth: sign-up/sign-in (email+password), organizations (= tenants), active org |
| `POST/GET /v1/sites` | minimal site (devices belong to a site) |
| `POST /v1/devices` | add + probe (credentials accepted on input only, stored AES-256-GCM, never returned) |
| `GET /v1/devices`, `/v1/devices/:id` | devices with capabilities and cameras |
| `GET /v1/cameras`, `/v1/cameras/:id` | cameras |
| `POST /v1/cameras/:id/snapshot` | `image/jpeg` |
| `GET /v1/audit` | tenant audit log (owner only) |
| `GET /healthz`, `/readyz` | liveness, readiness (DB) |

Roles (Better Auth org roles → PRD roles): `owner`→owner, `admin`→operator, `member`→viewer.
Add device / snapshot need operator+, audit needs owner, reads need any member.

## Tests and checks

| Command | What it runs |
|---|---|
| `pnpm install --frozen-lockfile` | install |
| `pnpm lint` | Biome (lint + format check) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test:unit` | unit tests (whitelist, vault, digest, target policy, config/redaction) |
| `pnpm test:integration` | integration tests: API + real PostgreSQL + mock ONVIF (tenant isolation, RLS, secrets, whitelist, audit, OpenAPI) |
| `pnpm test` | unit + integration |
| `pnpm build` | typecheck libs, bundle the API with tsup (`apps/api/dist`) |
| `pnpm verify` | lint + typecheck + test + build |

Integration tests need PostgreSQL and (re)create the database `pantau_test`. They connect as superuser to
`PANTAU_TEST_ADMIN_URL` (default `postgresql://postgres:postgres@127.0.0.1:5432/postgres`; `pnpm db:setup` sets that
dummy password). They never contact anything except the in-process mock on 127.0.0.1.

## Layout

```
apps/api            Fastify 5 + Zod + OpenAPI, Better Auth mount, routes, vault, target policy
packages/contracts  Zod schemas shared by API (and later agent/web)
packages/db         SQL migrations (RLS), Drizzle schema, withTenant()
packages/auth       Better Auth config (organization plugin)
packages/onvif-client  guarded wrapper around `onvif` 1.0.0-rc.3 (whitelist, host pinning, deadline)
packages/adapters   onvif-generic probe + snapshot, HTTP Digest
packages/mock-onvif in-process mock ONVIF device (SOAP + digest snapshot) used by tests and demos
docs/               DECISIONS.md, HASIL-CLOUD.md, openapi.json
```
