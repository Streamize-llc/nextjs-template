import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { billingErrorMessage, GENERIC_BILLING_ERROR } from "@/components/billing/messages";
import { formatDate, formatMinor, formatPrice } from "@/components/billing/format";
import { PricingTable } from "@/components/billing/pricing-table";
import { billingConfig } from "@/config/billing";

const render = (available: string[], currentPlanKey: string | null = null) =>
  renderToStaticMarkup(createElement(PricingTable, { plans: billingConfig.plans, currency: "USD", loginPath: "/login", currentPlanKey, available }));

describe("PricingTable", () => {
  it("shows every plan with its monthly price first and a switch to the yearly one", () => {
    const html = render(["pro:month", "team:month"]);
    for (const plan of billingConfig.plans) assert.ok(html.includes(plan.name), plan.name);
    assert.ok(html.includes("$9") && html.includes("$29"), "monthly prices");
    assert.ok(html.includes("Monthly") && html.includes("Yearly"), "the switch");
    assert.ok(!html.includes("$90"), "yearly prices are not shown until the switch is used");
  });

  it("shows a buy button only for a price that is configured, and says so for the rest", () => {
    const html = render(["pro:month"]);
    assert.equal((html.match(/Choose /g) ?? []).length, 1);
    assert.ok(html.includes("Choose Pro"));
    assert.ok(html.includes("Not available yet."));
    assert.equal((render([]).match(/Choose /g) ?? []).length, 0, "a fresh clone shows no button that cannot work");
  });

  it("marks the plan the user already has instead of offering it again", () => {
    const html = render(["pro:month", "team:month"], "pro");
    assert.ok(html.includes("Your current plan"));
    assert.ok(!html.includes("Choose Pro"));
    assert.ok(html.includes("Choose Team"));
  });
});

describe("formatPrice and the error texts", () => {
  it("formats whole amounts without cents and others with", () => {
    assert.equal(formatPrice(9, "USD"), "$9");
    assert.equal(formatPrice(9.5, "USD"), "$9.50");
    assert.equal(formatPrice(1000, "USD"), "$1,000");
  });

  it("formats Paddle's minor units and dates", () => {
    assert.equal(formatMinor(990, "USD"), "$9.90");
    assert.equal(formatMinor(900, "USD"), "$9");
    assert.equal(formatMinor(29000, "USD"), "$290");
    assert.equal(formatDate("2026-11-14T12:00:00Z"), "November 14, 2026");
    assert.equal(formatDate(null), "");
  });

  it("gives every code the routes answer with a text, and a generic one for anything else", () => {
    for (const code of ["unauthorized", "already_subscribed", "email_required", "customer_conflict", "price_not_configured", "unknown_item", "paddle_not_configured", "too_many_requests", "no_customer", "paddle_js_failed"]) {
      assert.notEqual(billingErrorMessage(code), GENERIC_BILLING_ERROR, code);
    }
    for (const unknown of ["checkout_failed", "weird", "", null, undefined]) assert.equal(billingErrorMessage(unknown), GENERIC_BILLING_ERROR, String(unknown));
  });
});

// A function exported from a "use client" file cannot be called from the server. `next build` does not notice; the page fails at request time,
// and only for a user whose data makes it call the function (this once broke /billing for everybody who had a payment). A server file may import
// only COMPONENTS (capitalised names) and types from a client module; helpers belong in a module without the directive (components/billing/format.ts).
describe("server files and client modules", () => {
  const root = new URL("../src/", import.meta.url);
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]));
  const isClient = (file: URL) => /^\s*["']use client["'];?/.test(readFileSync(file, "utf8"));
  const resolveImport = (from: URL, specifier: string): URL | null => {
    const base = specifier.startsWith("@/") ? new URL(specifier.slice(2), root) : specifier.startsWith(".") ? new URL(specifier, from) : null;
    if (!base) return null;
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = new URL(base.href + suffix);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // try the next suffix
      }
    }
    return null;
  };

  it("never calls a helper that lives in a client module", () => {
    const problems: string[] = [];
    for (const file of walk(root).filter((url) => /\.(ts|tsx)$/.test(url.pathname) && !isClient(url))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
        if (match[1]) continue;
        const target = resolveImport(file, match[3]);
        if (!target || !isClient(target)) continue;
        for (const name of match[2].split(",").map((part) => part.trim()).filter(Boolean)) {
          if (name.startsWith("type ")) continue;
          const local = name.split(/\s+as\s+/)[0];
          if (!/^[A-Z]/.test(local)) problems.push(`${file.pathname.split("/src/")[1]} imports "${local}" from the client module ${match[3]}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("keeps format.ts free of the client directive", () => {
    assert.equal(isClient(new URL("components/billing/format.ts", root)), false);
  });

  it("would have caught the original mistake (the guard itself works)", () => {
    const clientFile = new URL("components/billing/pricing-table.tsx", root);
    assert.equal(isClient(clientFile), true);
    assert.ok(!/export function formatPrice/.test(readFileSync(clientFile, "utf8")), "formatPrice moved out of the client module");
  });
});
