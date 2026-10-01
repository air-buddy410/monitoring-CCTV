import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const { app, close } = await buildApp({ config });
const shutdown = () => void close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ port: config.port, host: "0.0.0.0" });
