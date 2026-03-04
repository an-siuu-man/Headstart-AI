export class SupabaseRestError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "SupabaseRestError";
    this.status = status;
    this.details = details;
  }
}

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL is not configured.");
  }
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  return {
    url: url.replace(/\/$/, ""),
    serviceRoleKey,
  };
}

function buildSupabaseAuthHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

export async function supabaseTableRequest<T>(input: {
  table: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  single?: boolean;
}): Promise<T> {
  const { url, serviceRoleKey } = getSupabaseEnv();
  const method = input.method ?? "GET";

  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined) continue;
    queryParams.set(key, String(value));
  }

  const endpoint = `${url}/rest/v1/${input.table}${
    queryParams.size > 0 ? `?${queryParams.toString()}` : ""
  }`;

  const headers: Record<string, string> = {
    ...buildSupabaseAuthHeaders(serviceRoleKey),
    Accept: input.single ? "application/vnd.pgrst.object+json" : "application/json",
    ...input.headers,
  };

  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(endpoint, {
    method,
    headers,
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    cache: "no-store",
  });

  const rawText = await response.text();
  const hasBody = rawText.trim().length > 0;
  const parsedBody = hasBody ? safeJsonParse(rawText) : null;

  if (!response.ok) {
    throw new SupabaseRestError(
      `Supabase ${method} ${input.table} failed (${response.status})`,
      response.status,
      parsedBody ?? rawText,
    );
  }

  if (!hasBody) {
    return null as T;
  }

  if (parsedBody === null) {
    throw new Error(`Supabase ${method} ${input.table} returned non-JSON response.`);
  }

  return parsedBody as T;
}

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function supabaseStorageUploadObject(input: {
  bucket: string;
  path: string;
  data: Uint8Array;
  contentType?: string;
  upsert?: boolean;
}) {
  const { url, serviceRoleKey } = getSupabaseEnv();
  const encodedPath = encodeStoragePath(input.path);
  const endpoint = `${url}/storage/v1/object/${encodeURIComponent(input.bucket)}/${encodedPath}`;
  const copy = new Uint8Array(input.data.byteLength);
  copy.set(input.data);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...buildSupabaseAuthHeaders(serviceRoleKey),
      "Content-Type": input.contentType ?? "application/octet-stream",
      "x-upsert": input.upsert ? "true" : "false",
    },
    body: new Blob([copy.buffer], {
      type: input.contentType ?? "application/octet-stream",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const rawText = await response.text();
    throw new SupabaseRestError(
      `Supabase storage upload failed (${response.status})`,
      response.status,
      safeJsonParse(rawText) ?? rawText,
    );
  }
}

export async function supabaseStorageDeleteObject(input: {
  bucket: string;
  path: string;
}) {
  const { url, serviceRoleKey } = getSupabaseEnv();
  const encodedPath = encodeStoragePath(input.path);
  const endpoint = `${url}/storage/v1/object/${encodeURIComponent(input.bucket)}/${encodedPath}`;

  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      ...buildSupabaseAuthHeaders(serviceRoleKey),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const rawText = await response.text();
    throw new SupabaseRestError(
      `Supabase storage delete failed (${response.status})`,
      response.status,
      safeJsonParse(rawText) ?? rawText,
    );
  }

  return true;
}

export async function supabaseStorageCreateSignedUrl(input: {
  bucket: string;
  path: string;
  expiresInSeconds: number;
}) {
  const { url, serviceRoleKey } = getSupabaseEnv();
  const encodedPath = encodeStoragePath(input.path);
  const endpoint = `${url}/storage/v1/object/sign/${encodeURIComponent(input.bucket)}/${encodedPath}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...buildSupabaseAuthHeaders(serviceRoleKey),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      expiresIn: Math.max(60, Math.floor(input.expiresInSeconds)),
    }),
    cache: "no-store",
  });

  const rawText = await response.text();
  const parsedBody = rawText.trim().length > 0 ? safeJsonParse(rawText) : null;

  if (!response.ok) {
    throw new SupabaseRestError(
      `Supabase signed URL creation failed (${response.status})`,
      response.status,
      parsedBody ?? rawText,
    );
  }

  if (!parsedBody || typeof parsedBody !== "object") {
    throw new Error("Supabase signed URL response was empty.");
  }

  const signedPath = (parsedBody as Record<string, unknown>).signedURL;
  if (typeof signedPath !== "string" || signedPath.trim().length === 0) {
    throw new Error("Supabase signed URL response missing signedURL.");
  }

  const absolute = signedPath.startsWith("http")
    ? signedPath
    : `${url}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;

  return absolute;
}

function safeJsonParse(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function sha256Hex(value: string) {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((buffer) => Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join(""));
}

export function extractDomainFromUrl(url: string | undefined) {
  if (!url) return "canvas.unknown.local";
  try {
    return new URL(url).hostname || "canvas.unknown.local";
  } catch {
    return "canvas.unknown.local";
  }
}

export function canonicalizeJson(value: unknown) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = sortObject(input[key]);
  }
  return output;
}
