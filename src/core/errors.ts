export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function paging(query: Record<string, unknown>): { limit: number; offset: number } {
  const limitRaw = query.limit ?? 50;
  const offsetRaw = query.offset ?? 0;
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError("INVALID_LIMIT", "limit must be an integer in 1..500", 400);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError("INVALID_OFFSET", "offset must be a non-negative integer", 400);
  }
  return { limit, offset };
}

export function requireId(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError("INVALID_ID", `${name} must be a positive integer`, 400);
  }
  return n;
}
