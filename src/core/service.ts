import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { parseImage, exportFile } from "../fat/parser.ts";
import { Repository } from "../db/repository.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ServiceOptions {
  dbPath: string;
  /** Root that images and exports must live under (project directory). */
  projectRoot: string;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

export class InspectorService {
  readonly repo: Repository;
  private readonly projectRoot: string;
  private readonly now: () => number;
  private imageBuffers = new Map<number, Buffer>();

  constructor(opts: ServiceOptions) {
    this.repo = new Repository(opts.dbPath);
    this.projectRoot = resolve(opts.projectRoot);
    this.now = opts.now ?? (() => Date.now());
  }

  close(): void {
    this.repo.close();
  }

  private assertInsideProject(target: string): string {
    const abs = isAbsolute(target) ? resolve(target) : resolve(this.projectRoot, target);
    const rel = relative(this.projectRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ApiError(
        "PATH_OUTSIDE_PROJECT",
        400,
        `Path "${target}" resolves outside the project sandbox (${this.projectRoot}).`,
      );
    }
    return abs;
  }

  importImage(inputPath: string): {
    imageId: number; runId: number; reusedImage: boolean; summary: Record<string, unknown>;
  } {
    const abs = this.assertInsideProject(inputPath);
    if (!existsSync(abs)) throw new ApiError("IMAGE_NOT_FOUND", 404, `No image at ${abs}.`);
    const buf = readFileSync(abs);
    if (buf.length === 0) throw new ApiError("IMAGE_EMPTY", 400, "Image file is empty.");
    const result = parseImage(buf, { imagePath: abs, now: this.now() });
    const { imageId, runId, reusedImage } = this.repo.importParse(result);
    this.imageBuffers.set(imageId, buf);
    const counts = {
      error: result.issues.filter((i) => i.severity === "error").length,
      warning: result.issues.filter((i) => i.severity === "warning").length,
      info: result.issues.filter((i) => i.severity === "info").length,
    };
    return {
      imageId,
      runId,
      reusedImage,
      summary: {
        sha256: result.sha256,
        imageSize: result.imageSize,
        totalClusters: result.params.totalClusters,
        entries: result.entries.length,
        files: result.entries.filter((e) => e.kind === "file").length,
        directories: result.entries.filter((e) => e.kind === "directory").length,
        ...counts,
      },
    };
  }

  private bufferFor(imageId: number): Buffer {
    const cached = this.imageBuffers.get(imageId);
    if (cached) return cached;
    const image = this.repo.getImage(imageId);
    if (!image) throw new ApiError("IMAGE_NOT_FOUND", 404, `Image ${imageId} not found.`);
    const buf = readFileSync(image.imagePath);
    this.imageBuffers.set(imageId, buf);
    return buf;
  }

  exportImageFile(imageId: number, filePath: string, outRel: string, runIndex: number | null): {
    bytes: number; sha256: string; outputPath: string;
  } {
    const buf = this.bufferFor(imageId);
    const result = parseImage(buf, {
      imagePath: this.repo.getImage(imageId)?.imagePath ?? "",
      now: this.now(),
    });
    const entry = result.entries.find(
      (e) => (e.kind === "file") && e.path === filePath && !e.deleted,
    );
    if (!entry) throw new ApiError("FILE_NOT_FOUND", 404, `No live file entry for ${filePath}.`);
    const { data, issues } = exportFile(buf, result, entry);
    const fatal = issues.filter((i) => i.severity === "error");
    if (fatal.length > 0 && data.length !== entry.fileSize) {
      throw new ApiError(
        "EXPORT_INCOMPLETE",
        409,
        `Refusing incomplete export: ${fatal[0]!.message}`,
      );
    }
    const outputPath = this.assertInsideProject(join(this.projectRoot, outRel));
    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileSync(outputPath, data);
    return {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      outputPath,
    };
  }

  /** Compare two check-run versions of one image, returning added/resolved issue codes. */
  compareRuns(imageId: number, aIndex: number, bIndex: number): Record<string, unknown> {
    const runA = this.repo.resolveRun(imageId, aIndex);
    const runB = this.repo.resolveRun(imageId, bIndex);
    if (runA === null || runB === null) {
      throw new ApiError("RUN_NOT_FOUND", 404, "One or both check runs do not exist.");
    }
    const sig = (runId: number): Map<string, number> => {
      const page = this.repo.listIssues(imageId, this.runIndexOf(runId), 100000, 0, null);
      const map = new Map<string, number>();
      for (const i of page.items) {
        const key = `${i.code}@${i.offset ?? "-"}:${i.cluster ?? "-"}:${i.path ?? "-"}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return map;
    };
    const mapA = sig(runA);
    const mapB = sig(runB);
    const added: string[] = [];
    const resolved: string[] = [];
    for (const [k, v] of mapB) if ((mapA.get(k) ?? 0) < v) added.push(k);
    for (const [k, v] of mapA) if ((mapB.get(k) ?? 0) < v) resolved.push(k);
    return { runA: aIndex, runB: bIndex, added, resolved };
  }

  private runIndexOf(runId: number): number {
    const row = this.repo.db
      .prepare("SELECT run_index AS r FROM check_runs WHERE id = ?")
      .get(runId) as { r: number } | undefined;
    return row?.r ?? 0;
  }
}

export function validatePagination(raw: {
  limit?: unknown;
  offset?: unknown;
}): { limit: number; offset: number } {
  const limit = Number(raw.limit ?? 50);
  const offset = Number(raw.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError("INVALID_PAGINATION", 400, "limit must be an integer in [1, 500].");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError("INVALID_PAGINATION", 400, "offset must be a non-negative integer.");
  }
  return { limit, offset };
}
