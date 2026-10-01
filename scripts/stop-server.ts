/** Stop only the server process previously started by this project. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pidFile = resolve(root, "data", "server.pid");

if (!existsSync(pidFile)) {
  console.log("no server pid file; nothing to stop");
  process.exit(0);
}
const pid = Number(readFileSync(pidFile, "utf8").trim());
try {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGTERM");
  }
  console.log(`stopped server pid ${pid}`);
} catch {
  console.log(`server pid ${pid} was not running`);
} finally {
  rmSync(pidFile, { force: true });
  rmSync(resolve(root, "data", "server.port"), { force: true });
}
