import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { InspectorService, ApiError, validatePagination } from "../core/service.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");

interface ServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export function startServer(
  dbPath: string,
  preferredPort = 0,
  rootOverride?: string,
): Promise<ServerHandle> {
  const service = new InspectorService({ dbPath, projectRoot: rootOverride ?? projectRoot });
  const server = createServer((req, res) => {
    handle(req, res, service).catch((err: unknown) => {
      sendError(res, err);
    });
  });

  return new Promise((resolveHandle) => {
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      mkdirSync(resolve(projectRoot, "data"), { recursive: true });
      writeFileSync(resolve(projectRoot, "data", "server.pid"), String(process.pid));
      resolveHandle({
        server,
        port,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          service.close();
        },
      });
    });
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_JSON", 400, "Request body was not valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message } });
}

function requireBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new ApiError("INVALID_BODY", 400, "JSON object body required.");
  }
  return body as Record<string, unknown>;
}

function asId(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError("INVALID_PARAMETER", 400, `${name} must be a positive integer.`);
  }
  return n;
}

function asOptionalInt(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError("INVALID_PARAMETER", 400, `${name} must be a positive integer.`);
  }
  return n;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: InspectorService,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { status: "ok", bound: "127.0.0.1" });
    return;
  }

  if (method === "POST" && path === "/images/import") {
    const body = requireBody(await readJson(req));
    if (typeof body.path !== "string" || body.path.trim() === "") {
      throw new ApiError("INVALID_PARAMETER", 400, "body.path must be a non-empty string.");
    }
    const result = service.importImage(body.path);
    sendJson(res, 200, result);
    return;
  }

  const imagesMatch = path.match(/^\/images\/(\d+)$/);
  if (method === "GET" && imagesMatch) {
    const id = asId(imagesMatch[1], "imageId");
    const image = service.repo.getImage(id);
    if (!image) throw new ApiError("IMAGE_NOT_FOUND", 404, `Image ${id} not found.`);
    sendJson(res, 200, {
      image,
      volume: service.repo.getVolumeParams(id),
      runs: service.repo.listRuns(id),
    });
    return;
  }

  if (method === "GET" && path === "/images") {
    const { limit, offset } = validatePagination({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    sendJson(res, 200, service.repo.listImages(limit, offset));
    return;
  }

  const entriesMatch = path.match(/^\/images\/(\d+)\/entries$/);
  if (method === "GET" && entriesMatch) {
    const id = asId(entriesMatch[1], "imageId");
    const { limit, offset } = validatePagination({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    const run = asOptionalInt(url.searchParams.get("run"), "run");
    const kind = url.searchParams.get("kind");
    const parent = url.searchParams.get("parent");
    sendJson(
      res,
      200,
      service.repo.listEntries(id, run, limit, offset, kind, parent),
    );
    return;
  }

  const clustersMatch = path.match(/^\/images\/(\d+)\/clusters$/);
  if (method === "GET" && clustersMatch) {
    const id = asId(clustersMatch[1], "imageId");
    const { limit, offset } = validatePagination({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    const run = asOptionalInt(url.searchParams.get("run"), "run");
    sendJson(res, 200, service.repo.listClusters(id, run, limit, offset, url.searchParams.get("status")));
    return;
  }

  const chainMatch = path.match(/^\/images\/(\d+)\/chain$/);
  if (method === "GET" && chainMatch) {
    const id = asId(chainMatch[1], "imageId");
    const filePath = url.searchParams.get("path");
    if (!filePath) throw new ApiError("INVALID_PARAMETER", 400, "query.path is required.");
    const run = asOptionalInt(url.searchParams.get("run"), "run");
    const chain = service.repo.getChain(id, filePath, run);
    if (!chain) throw new ApiError("CHAIN_NOT_FOUND", 404, `No chain for ${filePath}.`);
    sendJson(res, 200, chain);
    return;
  }

  const issuesMatch = path.match(/^\/images\/(\d+)\/issues$/);
  if (method === "GET" && issuesMatch) {
    const id = asId(issuesMatch[1], "imageId");
    const { limit, offset } = validatePagination({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    const run = asOptionalInt(url.searchParams.get("run"), "run");
    sendJson(res, 200, service.repo.listIssues(id, run, limit, offset, url.searchParams.get("severity")));
    return;
  }

  if (method === "GET" && /^\/images\/\d+\/compare$/.test(path)) {
    const id = asId(path.split("/")[2]!, "imageId");
    const a = asOptionalInt(url.searchParams.get("a"), "a");
    const b = asOptionalInt(url.searchParams.get("b"), "b");
    if (a === null || b === null) {
      throw new ApiError("INVALID_PARAMETER", 400, "Both ?a and ?b run indexes are required.");
    }
    sendJson(res, 200, service.compareRuns(id, a, b));
    return;
  }

  if (method === "POST" && /^\/images\/\d+\/export$/.test(path)) {
    const id = asId(path.split("/")[2]!, "imageId");
    const body = requireBody(await readJson(req));
    if (typeof body.path !== "string" || body.path.trim() === "") {
      throw new ApiError("INVALID_PARAMETER", 400, "body.path must be a non-empty string.");
    }
    if (typeof body.output !== "string" || body.output.includes("\0")) {
      throw new ApiError("INVALID_PARAMETER", 400, "body.output must be a relative project path.");
    }
    if (body.output.startsWith("/") || /^[a-zA-Z]:/.test(body.output)) {
      throw new ApiError("PATH_OUTSIDE_PROJECT", 400, "body.output must be relative to the project.");
    }
    const run = asOptionalInt(body.run as string, "run");
    sendJson(res, 200, service.exportImageFile(id, body.path, body.output, run));
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${path}` } });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]!) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const requested = Number(process.env.PORT ?? 0);
  startServer(resolve(projectRoot, "data", "inspector.db"), Number.isInteger(requested) ? requested : 0)
    .then((handle) => {
      console.log(`FAT16 inspector API listening on http://127.0.0.1:${handle.port}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export const internals = { projectRoot };
