import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { Store } from "../src/db/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const path = resolve(root, "data", "mig-check.db");
for (const suf of ["", "-wal", "-shm"]) rmSync(path + suf, { force: true });

const a = new Store(path);
const b = new Store(path);
b.close();
a.close();
const c = new Store(path);
c.close();
for (const suf of ["", "-wal", "-shm"]) rmSync(path + suf, { force: true });
console.log("repeated migration ok");
