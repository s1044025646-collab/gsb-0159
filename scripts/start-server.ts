import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/api/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
mkdirSync(resolve(root, "data"), { recursive: true });

const port = Number(process.env.PORT ?? 0);
const { port: bound } = await startServer({
  dbPath: resolve(root, "data", "fat16.db"),
  projectRoot: root,
  port: Number.isInteger(port) ? port : 0,
});

writeFileSync(resolve(root, "data", "server.pid"), String(process.pid));
writeFileSync(resolve(root, "data", "server.port"), String(bound));
console.log(`FAT16 API listening on http://127.0.0.1:${bound} (pid ${process.pid})`);

const shutdown = () => process.exit(0);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
