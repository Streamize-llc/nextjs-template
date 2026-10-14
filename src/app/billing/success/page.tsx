import type { Metadata } from "next";
import { SuccessPoller } from "@/components/billing/success-poller";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false },
};

/** Where Paddle's checkout returns after a payment (`successUrl`). The poller waits for the webhook, and asks the server to sync if it is slow. */
export default function BillingSuccessPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-6 py-24 text-center">
      <SuccessPoller />
    </main>
  );
}
