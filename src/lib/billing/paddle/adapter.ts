import type { ProviderAdapter } from "../adapter";
import { itemForProviderRef } from "../catalog";
import { readCustomerLinks } from "../customers";
import { supabaseBillingStore } from "../store";
import { createPortalSession, createTransaction } from "./api";
import { getPaddleServerConfig, paddleClientConfig } from "./config";
import { ensureBillingCustomer } from "./customers";
import { syncPaddleCustomer } from "./sync";
import type { WebhookContext } from "./webhook";

/** What the webhook and the sync need to know about this app: which prices are ours, and the tag that tells our events from another app's. */
export function paddleWebhookContext(appTag: string): WebhookContext {
  return { appTag, itemForPriceId: (priceId) => itemForProviderRef("paddle", priceId) };
}

export const paddleAdapter: ProviderAdapter = {
  provider: "paddle",
  requiresVerifiedEmail: true,

  async createCheckout({ db, user, item, ref }) {
    const config = getPaddleServerConfig();
    const client = paddleClientConfig();
    if (!client.token) throw new Error("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set");
    if (!user.email) throw new Error("a Paddle checkout needs the user's e-mail");
    const customerId = await ensureBillingCustomer(db, { id: user.id, email: user.email }, config.appTag);
    const transactionId = await createTransaction({
      priceId: ref,
      customerId,
      customData: { app: config.appTag, user_id: user.id, item_key: item.key, interval: item.interval },
    });
    return { provider: "paddle", transactionId, clientToken: client.token, environment: client.environment };
  },

  async createPortal({ db, user, subscriptionIds }) {
    const customerId = (await readCustomerLinks(db, user.id)).paddleCustomerId;
    if (!customerId) return null;
    const session = await createPortalSession(customerId, subscriptionIds);
    return { url: session.overview, cancelUrl: session.cancel };
  },

  async sync({ db, user }) {
    const customerId = (await readCustomerLinks(db, user.id)).paddleCustomerId;
    if (!customerId) return;
    await syncPaddleCustomer(supabaseBillingStore(db), customerId, user.id, paddleWebhookContext(getPaddleServerConfig().appTag));
  },
};
