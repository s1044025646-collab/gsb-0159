import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { FatService } from "../core/service.js";
import { ApiError, paging, requireId } from "../core/errors.js";
import { Store } from "../db/store.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ApiError("INVALID_BODY", "Request body must be a JSON object", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SyntaxError) throw new ApiError("INVALID_JSON", "Body is not valid JSON", 400);
    throw e;
  }
}

function requireStr(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ApiError("INVALID_PARAM", `${key} must be a non-empty string`, 400);
  }
  return v;
}

export function createApp(service: FatService): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const query = Object.fromEntries(url.searchParams.entries());

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { status: "ok" });
      }

      if (req.method === "POST" && path === "/images/import") {
        const body = await readJson(req);
        const file = requireStr(body, "path");
        const result = service.importImage(resolve(file), typeof body.name === "string" ? body.name : undefined);
        return send(res, 200, result);
      }

      if (req.method === "GET" && path === "/images") {
        const { limit, offset } = paging(query);
        return send(res, 200, service.listImages(limit, offset));
      }

      const mImage = path.match(/^\/images\/(\d+)$/);
      if (req.method === "GET" && mImage) {
        return send(res, 200, service.summary(requireId(mImage[1], "imageId")));
      }

      const mEntries = path.match(/^\/images\/(\d+)\/entries$/);
      if (req.method === "GET" && mEntries) {
        const { limit, offset } = paging(query);
        const kind = typeof query.kind === "string" ? query.kind : undefined;
        return send(res, 200, service.listEntries(requireId(mEntries[1], "imageId"), limit, offset, kind));
      }

      const mChain = path.match(/^\/images\/(\d+)\/chains\/(\d+)$/);
      if (req.method === "GET" && mChain) {
        return send(
          res,
          200,
          service.traceChain(requireId(mChain[1], "imageId"), requireId(mChain[2], "cluster")),
        );
      }

      const mIssues = path.match(/^\/images\/(\d+)\/issues$/);
      if (req.method === "GET" && mIssues) {
        const { limit, offset } = paging(query);
        const code = typeof query.code === "string" ? query.code : undefined;
        return send(res, 200, service.listIssues(requireId(mIssues[1], "imageId"), limit, offset, code));
      }

      const mCompare = path.match(/^\/images\/(\d+)\/compare$/);
      if (req.method === "GET" && mCompare) {
        const a = requireId(query.scanA, "scanA");
        const b = requireId(query.scanB, "scanB");
        return send(res, 200, service.compareScans(requireId(mCompare[1], "imageId"), a, b));
      }

      if (req.method === "POST" && path === "/export") {
        const body = await readJson(req);
        const imageId = requireId(body.imageId, "imageId");
        const logical = requireStr(body, "path");
        const dest = requireStr(body, "dest");
        const source = typeof body.source === "string" ? body.source : undefined;
        return send(res, 200, service.exportFile(imageId, logical, dest, source));
      }

      return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${req.method} ${path}` } });
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
      }
      const message = e instanceof Error ? e.message : "unknown error";
      return send(res, 500, { error: { code: "INTERNAL", message } });
    }
  });
}

export interface StartOptions {
  dbPath: string;
  projectRoot: string;
  /** 0 = let the OS assign an ephemeral loopback port. */
  port?: number;
}

export function startServer(opts: StartOptions): Promise<{ server: Server; port: number; close: () => void }> {
  const store = new Store(opts.dbPath);
  const service = new FatService(store, opts.projectRoot);
  const server = createApp(service);
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({
        server,
        port,
        close: () => server.close(() => store.close()),
      });
    });
  });
}
