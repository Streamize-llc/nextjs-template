// No "use client" here on purpose: these are called from server components (/billing) and from client components (the pricing table).
// A function exported from a "use client" file cannot be called from the server, which fails only at request time, for a user who has payments.

/** 9 -> "$9", 9.5 -> "$9.50", in English. Pass your own locale here when you localise the app. */
export function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
}

/** Paddle's minor units (990) as a price ("$9.90"). */
export function formatMinor(minorUnits: number, currency: string): string {
  return formatPrice(minorUnits / 100, currency);
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
}
