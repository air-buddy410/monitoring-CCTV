# Satu image Node dipakai bersama oleh mock-device, migrate, dan api (hemat disk docker-01).
# Konteks build = akar repo. Hanya API yang di-bundle; paket internal diekspor sebagai sumber TS
# dan dibundel oleh tsup (lihat apps/api/tsup.config.ts), jadi `node dist/server.js` cukup.
FROM node:24-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pantau/api build
ENV NODE_ENV=production
CMD ["node", "apps/api/dist/server.js"]
