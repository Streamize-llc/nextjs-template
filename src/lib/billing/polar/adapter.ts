import type { ProviderAdapter } from "../adapter";
import { itemForProviderRef } from "../catalog";
import { markPolarLinked, readCustomerLinks } from "../customers";
import { supabaseBillingStore } from "../store";
import { createCheckout, createPortalSession } from "./api";
import { syncPolarCustomer } from "./sync";
import type { PolarContext } from "./webhook";

/** What the webhook and the sync need to know about this app: which products are ours. */
export const polarContext: PolarContext = { itemForProductId: (productId) => itemForProviderRef("polar", productId) };

export const polarAdapter: ProviderAdapter = {
  provider: "polar",
  // The Polar customer is the user id, set by the server: an unconfirmed e-mail cannot reach anybody else's customer.
  requiresVerifiedEmail: false,

  async createCheckout({ db, user, item, ref, origin }) {
    // Remember that this user went to Polar, so the sync knows to ask. Harmless if the checkout is never paid.
    await markPolarLinked(db, user);
    const checkout = await createCheckout({
      productId: ref,
      userId: user.id,
      email: user.email,
      successUrl: `${origin}/billing/success?provider=polar&checkout_id={CHECKOUT_ID}`,
      returnUrl: `${origin}/pricing`,
      metadata: { user_id: user.id, item_key: item.key, ...(item.interval ? { interval: item.interval } : {}) },
    });
    return { provider: "polar", url: checkout.url };
  },

  async createPortal({ user, origin }) {
    const url = await createPortalSession(user.id, `${origin}/billing`);
    return url ? { url, cancelUrl: null } : null;
  },

  async sync({ db, user }) {
    if (!(await readCustomerLinks(db, user.id)).polarLinked) return;
    await syncPolarCustomer(supabaseBillingStore(db), user.id, polarContext);
  },
};
