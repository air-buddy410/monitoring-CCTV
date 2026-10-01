# Not built in CI yet (no Docker daemon in the dev sandbox): see docs/HASIL-GELOMBANG3.md.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @pantau/agent...
RUN pnpm --filter @pantau/agent build
RUN pnpm --filter @pantau/agent --prod deploy /out && cp -r apps/agent/dist /out/dist

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PANTAU_AGENT_DATA_DIR=/var/lib/pantau-agent \
    PANTAU_LOCAL_BIND=127.0.0.1
# a fixed unprivileged uid so the data volume can be owned by it
RUN useradd --system --uid 10001 --home-dir /var/lib/pantau-agent --shell /usr/sbin/nologin pantau-agent \
    && install -d -o pantau-agent -g pantau-agent -m 0700 /var/lib/pantau-agent
COPY --from=build /out /opt/pantau-agent
USER 10001:10001
WORKDIR /opt/pantau-agent
VOLUME ["/var/lib/pantau-agent"]
# no EXPOSE: the setup page listens on loopback and go2rtc is never published
ENTRYPOINT ["node", "dist/main.js"]
CMD ["run"]
