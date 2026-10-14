import type { ProviderAdapter } from "./adapter";
import { paddleAdapter } from "./paddle/adapter";
import { polarAdapter } from "./polar/adapter";
import type { Provider } from "./types";

const ADAPTERS: Record<Provider, ProviderAdapter> = { paddle: paddleAdapter, polar: polarAdapter };

export function adapterFor(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
