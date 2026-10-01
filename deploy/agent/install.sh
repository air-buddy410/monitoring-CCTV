#!/usr/bin/env bash
# Installs the agent as a systemd service. Not run against a real host yet: see docs/HASIL-GELOMBANG3.md.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
: "${PANTAU_API_URL:?set PANTAU_API_URL to the https URL of the PANTAU API}"
case "$PANTAU_API_URL" in
  https://*) ;;
  *) echo "PANTAU_API_URL must start with https://" >&2; exit 1 ;;
esac

SRC="${1:-./dist-agent}"
[[ -f "$SRC/dist/main.js" ]] || { echo "no build at $SRC (expected $SRC/dist/main.js)" >&2; exit 1; }

id pantau-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/pantau-agent --shell /usr/sbin/nologin pantau-agent
install -d -m 0755 /opt/pantau-agent
cp -r "$SRC"/. /opt/pantau-agent/
install -d -o pantau-agent -g pantau-agent -m 0700 /var/lib/pantau-agent
install -d -m 0750 -g pantau-agent /etc/pantau-agent

# the env file holds addresses only: no token, no camera password
umask 0137
cat >/etc/pantau-agent/agent.env <<ENV
PANTAU_API_URL=$PANTAU_API_URL
PANTAU_AGENT_DATA_DIR=/var/lib/pantau-agent
PANTAU_LOCAL_BIND=127.0.0.1
ENV
chgrp pantau-agent /etc/pantau-agent/agent.env

install -m 0644 "$(dirname "$0")/pantau-agent.service" /etc/systemd/system/pantau-agent.service

# the one-time enrollment token is read without echo and passed to a single process; it is never written to disk
read -rsp "Enrollment token from the NOC (input hidden): " TOKEN
echo
sudo -u pantau-agent env PANTAU_ENROLL_TOKEN="$TOKEN" PANTAU_API_URL="$PANTAU_API_URL" \
  PANTAU_AGENT_DATA_DIR=/var/lib/pantau-agent /usr/bin/node /opt/pantau-agent/dist/main.js enroll
unset TOKEN

systemctl daemon-reload
systemctl enable --now pantau-agent.service
echo "Agent running. Add cameras with: sudo -u pantau-agent env \$(cat /etc/pantau-agent/agent.env | xargs) node /opt/pantau-agent/dist/main.js setup"
