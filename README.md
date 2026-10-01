# PANTAU: backend, web, and on-site agent (PRD v0.2, M1 done, M2 started)

Multi-brand CCTV/VMS (PRD `PRD-LABS-PANTAU-002` v0.2). The repository now contains:

- **MVP-0 slice**: add a device manually, ONVIF probe, cameras, JPEG snapshot, with Better Auth organizations (tenants),
  PostgreSQL RLS, audit log, ONVIF method whitelist, and a mock ONVIF device so nothing needs a physical camera.
- **M1**: two-factor sign-in (TOTP and backup codes), per-camera grants, site and camera editing, audit action catalogue,
  `/healthz` and `/readyz`.
- **M2 (started)**: `apps/agent`, the on-site agent (outbound WebSocket, local credential vault, inventory sync, status),
  agent enrollment and revocation endpoints.

Not included yet: live video, go2rtc, WebRTC, TURN, WS-Discovery, agent local onboarding UI, NVR playback, motion
events, PWA, pg-boss worker, Hikvision/Dahua adapters, cross-tenant `noc`. **Nothing here has been tested against a
physical camera**; every device in tests and demos is a labelled simulation.

The web app (`apps/web`) covers sign-in with a second step, organizations, devices and snapshots, access grants,
account security, agents, and audit. See `DESIGN.md`, `docs/DEMO.md`, `docs/HASIL-FRONTEND.md`, `docs/HASIL-GELOMBANG2.md`
(wave 2 results), `docs/DECISIONS.md` (deviations from the PRD) and `docs/HASIL-CLOUD.md`.

## Requirements

- Node.js >= 22 (PRD targets 24 LTS; `.nvmrc` says 24, verified here on 22.22)
- pnpm 10 (`corepack enable`)
- PostgreSQL >= 16 reachable locally (PRD targets 17; verified on 16.14 and 17.10, see `docs/HASIL-LANJUTAN.md`)

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
| `/api/auth/*` | Better Auth: sign-up/sign-in (email+password), two-factor (`/two-factor/*`), organizations (= tenants), active org |
| `POST/GET /v1/sites`, `GET/PATCH/DELETE /v1/sites/:id` | sites (delete: owner or noc, cascades devices, cameras, agents, grants) |
| `POST /v1/devices` | add + probe from the API (interim path, D1): credentials accepted on input only, stored AES-256-GCM, never returned |
| `GET /v1/devices`, `/v1/devices/:id` | devices with capabilities and cameras (including those reported by agents) |
| `GET /v1/cameras`, `GET/PATCH /v1/cameras/:id` | cameras (PATCH: name and order only) |
| `POST /v1/cameras/:id/snapshot` | `image/jpeg`; needs an `operate` grant for operators |
| `GET/POST/DELETE /v1/grants` | per-camera or per-site access (owner or noc manage; others read their own) |
| `POST /v1/sites/:id/enrollments` | single-use agent enrollment token, 24 h (owner or noc) |
| `POST /v1/agent/enroll` | public; the enrollment token (`Authorization: Enroll ...`) is the credential |
| `GET /v1/agents`, `/v1/agents/:id`, `POST /v1/agents/:id/revoke` | agents, status, revocation |
| `WS /agent` | agent channel, `Authorization: Agent <token>` (hello, inventory.sync, status), see `packages/contracts/src/agent.ts` |
| `GET /v1/audit` | tenant audit log, filter by `action`, `from`, `to` (owner or noc) |
| `GET /healthz`, `/readyz` | liveness, readiness (named checks, 503 lists only names) |

Security settings (see `.env.example`): `TARGET_ALLOW_CIDRS` (explicit device target allow-list; default private LAN ranges),
`ALLOW_LOOPBACK_TARGETS` (lab exception), `TRUSTED_ORIGINS`, `TRUST_PROXY`, `RATE_LIMIT_*`. State-changing requests need a trusted
`Origin` (or none, for non-browser clients); `/api/auth` calls with a session cookie must send `Origin`.

Roles (Better Auth org roles → PRD roles): `owner`→owner, `admin`→operator, `member`→viewer, `noc`→noc (see `docs/DECISIONS.md` D20).
Add device and edit need operator or noc or owner, video (snapshot) needs owner, or operator with an `operate` grant (D21),
grants and agents are managed by owner or noc, audit is read by owner or noc, reads need any member.

## Tests and checks

| Command | What it runs |
|---|---|
| `pnpm install --frozen-lockfile` | install |
| `pnpm lint` | Biome (lint + format check) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test:unit` | unit tests (whitelist, vault, digest, target policy, config/redaction) |
| `pnpm test:integration` | integration tests: API + real PostgreSQL + mock ONVIF (tenant isolation, RLS, secrets, whitelist, audit, OpenAPI) |
| `pnpm test` | unit + integration |
| `pnpm build` | typecheck libs, bundle the API with tsup, build the web app (`apps/web/.next`) |
| `pnpm test:e2e` | browser tests (Playwright, Chromium) against the real API and PostgreSQL; needs `playwright install chromium` once, see `docs/DEMO.md` |
| `pnpm demo` | local "Simulasi" stack on http://localhost:3100 (mock ONVIF, dummy account), see `docs/DEMO.md` |
| `pnpm verify` | lint + typecheck + test + build |

### The agent

```bash
# NOC: Agen page in the web app (or POST /v1/sites/:id/enrollments) gives a one-time token.
# On the site's mini PC (credentials are read from the environment, never from arguments):
export PANTAU_API_URL=https://api.example.test PANTAU_AGENT_DATA_DIR=/var/lib/pantau-agent
PANTAU_ENROLL_TOKEN=pae_... pnpm --filter @pantau/agent exec tsx src/main.ts enroll   # used once, never stored
PANTAU_DEVICE_USER=... PANTAU_DEVICE_PASSWORD=... pnpm --filter @pantau/agent exec tsx src/main.ts add-device "NVR" 192.168.1.20 80
pnpm --filter @pantau/agent start   # run: stays connected, reconnects with backoff
```

The device password lives only in the agent's encrypted vault (`vault/`, mode 0600); the cloud receives metadata and
status. Lab-only switches: `PANTAU_ALLOW_LOOPBACK=true` (simulator on 127.0.0.1), `PANTAU_ALLOW_INSECURE=true` (http/ws).

Integration tests need PostgreSQL and (re)create the database `pantau_test`. They connect as superuser to
`PANTAU_TEST_ADMIN_URL` (default `postgresql://postgres:postgres@127.0.0.1:5432/postgres`; `pnpm db:setup` sets that
dummy password). They never contact anything except in-process mocks/decoys on 127.0.0.1. CI (`.github/workflows/ci.yml`) runs the same commands on Node 24 with a PostgreSQL 17 service.

## Layout

```
apps/api            Fastify 5 + Zod + OpenAPI, Better Auth mount, routes, vault, target policy
apps/web            Next.js 16 + Tailwind 4 frontend (login + 2FA, organization, devices, snapshots, access, security, agents, audit), Playwright E2E
apps/agent          on-site agent: enroll, credential vault, device registry, WebSocket client, CLI (`pantau-agent`)
packages/contracts  Zod schemas shared by API, agent and web (REST and the agent protocol)
packages/db         SQL migrations (RLS), Drizzle schema, withTenant()
packages/auth       Better Auth config (organization and two-factor plugins)
packages/onvif-client  guarded wrapper around `onvif` 1.0.0-rc.3 (whitelist, host pinning, deadline)
packages/adapters   onvif-generic probe + snapshot, HTTP Digest, target policy (shared by API and agent)
packages/mock-onvif in-process mock ONVIF device (SOAP + digest snapshot) used by tests and demos
docs/               DECISIONS.md, HASIL-*.md, openapi.json
```
