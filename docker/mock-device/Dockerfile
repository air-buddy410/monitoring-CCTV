# Mock ONVIF untuk uji AC1 (dipakai hanya di compose dev).
# Alasan: paket mock-onvif hanya bind 127.0.0.1 (lihat src/index.ts), jadi container ini
# WAJIB network_mode: host supaya API (juga host net) bisa menjangkaunya di 127.0.0.1.
# Kredensial di bawah DUMMY dan hanya untuk lab.
FROM node:24-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV MOCK_HOST=127.0.0.1
ENV MOCK_PORT=18081
CMD ["pnpm","--filter","@pantau/mock-onvif","exec","tsx","src/docker-cli.ts"]
