/**
 * Paddle.js, loaded from Paddle's CDN the first time a checkout is opened (nothing to install, nothing on pages that never sell).
 * https://developer.paddle.com/paddlejs/overview
 */
const SCRIPT_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";

interface PaddleGlobal {
  Environment: { set: (environment: "sandbox" | "production") => void };
  Initialize: (options: { token: string; eventCallback?: (event: { name?: string }) => void }) => void;
  Checkout: { open: (options: { transactionId: string; settings?: { displayMode?: "overlay" | "inline"; successUrl?: string; theme?: "light" | "dark" } }) => void };
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

let loading: Promise<PaddleGlobal> | null = null;
let initialisedWith: string | null = null;

function loadScript(): Promise<PaddleGlobal> {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  loading ??= new Promise<PaddleGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error("paddle_js_missing")));
    script.onerror = () => {
      loading = null;
      reject(new Error("paddle_js_failed"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Paddle.js, initialised once per token and environment. */
export async function getPaddle(token: string, environment: "sandbox" | "production"): Promise<PaddleGlobal> {
  const paddle = await loadScript();
  const signature = `${environment}:${token}`;
  if (initialisedWith !== signature) {
    // Environment.set must come before Initialize, and only sandbox needs it.
    if (environment === "sandbox") paddle.Environment.set("sandbox");
    paddle.Initialize({ token });
    initialisedWith = signature;
  }
  return paddle;
}
