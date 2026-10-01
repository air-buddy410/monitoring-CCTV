import { randomInt } from "node:crypto";
import { Agent } from "./agent";
import { DeviceError } from "./devices";
import { discover } from "./discovery";
import { loadAgentEnv } from "./env";
import { EnrollError } from "./identity";
import { startLocalUi } from "./local-ui";
import { createLogger } from "./logger";

const USAGE = `pantau-agent <command>

  enroll        register with the cloud (needs PANTAU_ENROLL_TOKEN, from the NOC; used once, never stored)
  add-device    probe a device on the LAN and keep its credentials in the local vault
                  usage: add-device <name> <host> [port]
                  credentials: PANTAU_DEVICE_USER and PANTAU_DEVICE_PASSWORD (never as arguments)
  setup         open the local setup page (PIN printed here): find cameras and add them with their passwords
  run           connect to the cloud and stay connected

Environment: PANTAU_API_URL (required), PANTAU_AGENT_DATA_DIR, PANTAU_AGENT_NAME, PANTAU_WS_URL,
PANTAU_LOG_LEVEL, PANTAU_LOCAL_BIND (default 127.0.0.1), PANTAU_LOCAL_PORT (default 8780). Lab only: PANTAU_ALLOW_LOOPBACK=true, PANTAU_ALLOW_INSECURE=true.
`;

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const env = loadAgentEnv();
  const logger = createLogger(env.logLevel);
  const base = {
    apiUrl: env.apiUrl,
    wsUrl: env.wsUrl,
    dataDir: env.dataDir,
    allowLoopback: env.allowLoopback,
    allowInsecure: env.allowInsecure,
    logger,
  };

  if (cmd === "enroll") {
    const token = process.env.PANTAU_ENROLL_TOKEN;
    if (!token) throw new EnrollError("enrollment_token_missing");
    const agent = await Agent.enroll({ ...base, enrollToken: token, name: env.name });
    console.log(`enrolled as ${agent.identity.agentId} at site ${agent.identity.siteId}`);
    return 0;
  }
  if (cmd === "add-device") {
    const [name, host, port] = args;
    const username = process.env.PANTAU_DEVICE_USER;
    const password = process.env.PANTAU_DEVICE_PASSWORD;
    if (!name || !host || !username || !password) {
      console.error("add-device needs <name> <host> and PANTAU_DEVICE_USER and PANTAU_DEVICE_PASSWORD");
      return 2;
    }
    const agent = Agent.load(base);
    const d = await agent.registry.add({ name, host, port: port ? Number(port) : 80, username, password });
    console.log(`added ${d.deviceKey}: ${d.brand} ${d.model}, ${d.cameras.length} camera(s)`);
    return 0;
  }
  if (cmd === "setup") {
    const agent = Agent.load(base);
    const pin = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const ui = await startLocalUi({
      registry: agent.registry,
      pin,
      bindHost: env.localBind,
      port: env.localPort,
      discover: () => discover({ allowLoopback: env.allowLoopback }),
    });
    // the PIN goes to the console only: not to the logger, a file or the cloud
    console.log(`setup page: ${ui.url}\nPIN: ${pin}\nPress Ctrl+C to close it.`);
    const stop = () => void ui.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return -1;
  }
  if (cmd === "run") {
    const agent = Agent.load(base);
    agent.client.on("unauthorized", () => {
      console.error("the server no longer accepts this agent (revoked or token replaced); exiting");
      process.exit(3);
    });
    const stop = () => void agent.stop().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    agent.start();
    return -1;
  }
  console.error(USAGE);
  return 2;
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((e: unknown) => {
    // codes only: library and server messages are never printed
    const code =
      e instanceof EnrollError || e instanceof DeviceError
        ? e.code
        : e instanceof Error
          ? e.message.split(":")[0]
          : "error";
    console.error(`pantau-agent: ${code}`);
    process.exit(1);
  });
