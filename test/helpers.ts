import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.js";
import { FatService, type Clock } from "../src/core/service.js";

export interface TempProject {
  root: string;
  store: Store;
  service: FatService;
  clock: { fixed: string; now(): Date };
  cleanup(): void;
}

/** Each test gets its own project dir + database for isolation. */
export function makeProject(): TempProject {
  const root = mkdtempSync(join(tmpdir(), "fat16-test-"));
  const store = new Store(join(root, "test.db"));
  const clock = { fixed: "2026-01-01T00:00:00.000Z", now: () => new Date(clock.fixed) };
  const service = new FatService(store, root, clock as Clock);
  return {
    root,
    store,
    service,
    clock,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function codes(scan: { issues: { code: string }[] }): string[] {
  return [...new Set(scan.issues.map((i) => i.code))];
}
