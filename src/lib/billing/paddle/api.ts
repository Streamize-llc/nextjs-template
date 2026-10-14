/**
 * The Paddle REST API, with `fetch` (no SDK, so nothing to install or keep up to date). Server only: it carries the secret API key.
 * https://developer.paddle.com/api-reference/overview
 */
import type { JsonObject } from "../types";
import { getPaddleServerConfig, PADDLE_API } from "./config";
import type { PaddleSubscription, PaddleTransaction } from "./types";

/** An error answer from Paddle. Plain fields (Node's type stripping does not support constructor parameter properties). */
export class PaddleApiError extends Error {
  status: number;
  code: string;
  detail: string;
  constructor(status: number, code: string, detail: string, path: string) {
    super(`Paddle ${path} -> ${status} ${code}: ${detail}`);
    this.name = "PaddleApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

interface PaddleEnvelope<T> {
  data?: T;
  error?: { code?: string; detail?: string };
  meta?: { pagination?: { has_more?: boolean; next?: string } };
}

type Fetch = typeof fetch;

export async function paddleFetch<T>(path: string, init: { method?: string; body?: unknown } = {}, fetcher: Fetch = fetch): Promise<PaddleEnvelope<T>> {
  const config = getPaddleServerConfig();
  const response = await fetcher(`${config.apiBase}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Paddle-Version": PADDLE_API.version },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as PaddleEnvelope<T>;
  if (!response.ok) throw new PaddleApiError(response.status, json.error?.code ?? "unknown", json.error?.detail ?? response.statusText, path);
  return json;
}

// ── customers ────────────────────────────────────────────────────────────────────────────────────────

/** The id of the Paddle customer with this e-mail, if any. A customer belongs to the whole Paddle account, so other apps may have made it. */
export async function findCustomerIdByEmail(email: string, fetcher?: Fetch): Promise<string | null> {
  const json = await paddleFetch<{ id: string }[]>(`/customers?email=${encodeURIComponent(email)}`, {}, fetcher);
  return json.data?.[0]?.id ?? null;
}

/**
 * The Paddle customer for this e-mail: found, or created. Creating a customer whose e-mail exists is a 409 that names the existing id,
 * so two apps (or two clicks) racing each other still end up with the same customer.
 */
export async function ensureCustomerId(email: string, customData: JsonObject, fetcher?: Fetch): Promise<string> {
  const existing = await findCustomerIdByEmail(email, fetcher);
  if (existing) return existing;
  try {
    const json = await paddleFetch<{ id: string }>("/customers", { method: "POST", body: { email, custom_data: customData } }, fetcher);
    if (json.data?.id) return json.data.id;
  } catch (error) {
    if (!(error instanceof PaddleApiError) || error.status !== 409) throw error;
    const named = /\b(ctm_[a-z0-9]+)\b/.exec(error.detail)?.[1];
    if (named) return named;
    const again = await findCustomerIdByEmail(email, fetcher);
    if (again) return again;
  }
  throw new Error("Paddle did not return a customer id");
}

// ── transactions and the customer portal ─────────────────────────────────────────────────────────────

/**
 * A transaction THIS server creates for one price, to be opened in the browser by its id (`Paddle.Checkout.open({ transactionId })`).
 * The price, the quantity and the customer are fixed here; the browser cannot change them.
 */
export async function createTransaction(input: { priceId: string; customerId: string; customData: JsonObject }, fetcher?: Fetch): Promise<string> {
  const json = await paddleFetch<{ id: string }>(
    "/transactions",
    {
      method: "POST",
      body: { items: [{ price_id: input.priceId, quantity: 1 }], customer_id: input.customerId, collection_mode: "automatic", custom_data: input.customData },
    },
    fetcher,
  );
  if (!json.data?.id) throw new Error("Paddle did not return a transaction id");
  return json.data.id;
}

/** Short-lived, already-signed-in links to Paddle's customer portal (payment method, invoices, cancel). Make a new one per click. */
export async function createPortalSession(customerId: string, subscriptionIds: readonly string[] = [], fetcher?: Fetch): Promise<{ overview: string; cancel: string | null }> {
  const json = await paddleFetch<{ urls?: { general?: { overview?: string }; subscriptions?: { cancel_subscription?: string }[] } }>(
    `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
    { method: "POST", body: subscriptionIds.length > 0 ? { subscription_ids: subscriptionIds } : {} },
    fetcher,
  );
  const overview = json.data?.urls?.general?.overview;
  if (!overview) throw new Error("Paddle did not return a portal link");
  return { overview, cancel: json.data?.urls?.subscriptions?.[0]?.cancel_subscription ?? null };
}

// ── reads for the self-heal sync ─────────────────────────────────────────────────────────────────────

export async function listSubscriptions(customerId: string, fetcher?: Fetch): Promise<(PaddleSubscription & { updated_at?: string })[]> {
  const json = await paddleFetch<(PaddleSubscription & { updated_at?: string })[]>(`/subscriptions?customer_id=${encodeURIComponent(customerId)}&per_page=50`, {}, fetcher);
  return json.data ?? [];
}

export async function listCompletedTransactions(customerId: string, fetcher?: Fetch): Promise<PaddleTransaction[]> {
  const json = await paddleFetch<PaddleTransaction[]>(`/transactions?customer_id=${encodeURIComponent(customerId)}&status=completed&order_by=billed_at%5BDESC%5D&per_page=50`, {}, fetcher);
  return json.data ?? [];
}
