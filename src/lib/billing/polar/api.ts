/**
 * The Polar REST API, with `fetch` (no SDK, so nothing to install or keep up to date). Server only: it carries the secret access token.
 * https://docs.polar.sh/api-reference
 */
import type { JsonObject } from "../types";
import { getPolarServerConfig } from "./config";
import type { PolarOrder, PolarSubscription } from "./types";

/** An error answer from Polar. Plain fields (Node's type stripping does not support constructor parameter properties). */
export class PolarApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string, path: string) {
    super(`Polar ${path} -> ${status}: ${detail}`);
    this.name = "PolarApiError";
    this.status = status;
    this.detail = detail;
  }
}

type Fetch = typeof fetch;

export async function polarFetch<T>(path: string, init: { method?: string; body?: unknown } = {}, fetcher: Fetch = fetch): Promise<T> {
  const config = getPolarServerConfig();
  const response = await fetcher(`${config.apiBase}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: reported below
  }
  if (!response.ok) {
    const body = json as { detail?: unknown; error_description?: unknown; error?: unknown } | null;
    const raw = body?.detail ?? body?.error_description ?? body?.error ?? response.statusText;
    throw new PolarApiError(response.status, typeof raw === "string" ? raw : JSON.stringify(raw), path);
  }
  return json as T;
}

/**
 * Polar refuses a checkout when the prefilled `customer_email` is not deliverable (it looks the domain up). That must not cost us the sale: the
 * buyer types the address on Polar's page instead. True for exactly that rejection.
 */
export function isCustomerEmailRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /customer_email/.test(message) && /not a valid email address|value_error|string_pattern/.test(message);
}

/**
 * Is this "Polar has no such customer"? For an external id Polar does not know, the customer-session endpoint answers 422 with the validation
 * message "Customer does not exist." (found against the real sandbox; 404 is accepted too). It means "this user has not paid at Polar yet", not an outage.
 */
export function isNoSuchCustomer(error: unknown): boolean {
  if (!(error instanceof PolarApiError)) return false;
  return error.status === 404 || (error.status === 422 && /customer does not exist/i.test(error.detail));
}

/**
 * A checkout THIS server creates for one product. The customer is the signed-in user: `external_customer_id` is the userId, set here and never by
 * the browser, and it is what every later payload is credited through. Returns the URL to send the buyer to.
 */
export async function createCheckout(
  input: { productId: string; userId: string; email: string | null; successUrl: string; returnUrl: string; metadata: JsonObject },
  fetcher?: Fetch,
): Promise<{ id: string; url: string }> {
  const body = { products: [input.productId], external_customer_id: input.userId, success_url: input.successUrl, return_url: input.returnUrl, metadata: input.metadata };
  let created: { id?: string; url?: string };
  try {
    created = await polarFetch("/v1/checkouts/", { method: "POST", body: input.email ? { ...body, customer_email: input.email } : body }, fetcher);
  } catch (error) {
    if (!input.email || !isCustomerEmailRejection(error)) throw error;
    created = await polarFetch("/v1/checkouts/", { method: "POST", body }, fetcher);
  }
  if (!created.id || !created.url) throw new Error("Polar did not return a checkout url");
  return { id: created.id, url: created.url };
}

/** A short-lived, already-signed-in link to Polar's customer portal (invoices, payment method, cancel). null: Polar has no customer for this user yet. */
export async function createPortalSession(userId: string, returnUrl: string, fetcher?: Fetch): Promise<string | null> {
  try {
    const session = await polarFetch<{ customer_portal_url?: string }>("/v1/customer-sessions/", { method: "POST", body: { external_customer_id: userId, return_url: returnUrl } }, fetcher);
    if (!session.customer_portal_url) throw new Error("Polar did not return a portal link");
    return session.customer_portal_url;
  } catch (error) {
    if (isNoSuchCustomer(error)) return null;
    throw error;
  }
}

// ── reads for the self-heal sync ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

async function listAll<T>(path: string, fetcher?: Fetch): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const json = await polarFetch<{ items?: T[]; pagination?: { max_page?: number } }>(`${path}&page=${page}&limit=${PAGE_SIZE}`, {}, fetcher);
    items.push(...(json.items ?? []));
    if (page >= (json.pagination?.max_page ?? 1)) break;
  }
  return items;
}

export function listSubscriptions(userId: string, fetcher?: Fetch): Promise<PolarSubscription[]> {
  return listAll<PolarSubscription>(`/v1/subscriptions/?external_customer_id=${encodeURIComponent(userId)}`, fetcher);
}

export function listOrders(userId: string, fetcher?: Fetch): Promise<PolarOrder[]> {
  return listAll<PolarOrder>(`/v1/orders/?external_customer_id=${encodeURIComponent(userId)}`, fetcher);
}
