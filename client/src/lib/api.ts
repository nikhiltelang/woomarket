import { QueryClient, type QueryFunctionContext } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch("/api/csrf-token", { credentials: "include" });
  const body = await res.json();
  csrfToken = body.csrfToken;
  return csrfToken!;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(url: string, params?: QueryParams): string {
  if (!params) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

/** JSON API request with session cookie and CSRF header; retries once on a stale CSRF token. */
export async function apiRequest<T = unknown>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken ?? (await fetchCsrfToken());

  const res = await fetch(url, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });

  if (res.status === 403 && !retried && method !== "GET") {
    const peek = await res.clone().json().catch(() => ({}));
    if (peek.code === "CSRF_INVALID") {
      await fetchCsrfToken();
      return apiRequest<T>(method, url, body, true);
    }
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.message ?? data?.error ?? `Request failed (${res.status})`, data?.code, data?.details);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: async ({ queryKey }: QueryFunctionContext) => {
        const [url, params] = queryKey as [string, QueryParams | undefined];
        return apiRequest("GET", buildUrl(url, params));
      },
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => (err instanceof ApiError ? err.status >= 500 && count < 2 : count < 2),
    },
    mutations: { retry: false },
  },
});

/** Field errors from a 400 validation response, keyed by field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.details || typeof err.details !== "object") return {};
  return Object.fromEntries(
    Object.entries(err.details as Record<string, string[] | undefined>).map(([k, v]) => [k, v?.[0] ?? "Invalid"]),
  );
}
