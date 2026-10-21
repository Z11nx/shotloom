/**
 * Reads the fal account's credit balance for the top bar.
 *
 * GET https://api.fal.ai/v1/account/billing?expand=credits needs a key with
 * billing-read permission (fal's BILLING, READONLY-with-billing or FULL presets).
 * An ordinary "API" key may be refused, so a separate read-only key can be set
 * as FAL_BILLING_KEY. Keys stay on the server; responses carry only numbers and
 * messages written here (never fal's raw error text or the key).
 *
 * Results are cached so the browser can ask freely: a minute after success,
 * longer after a permission error, and refreshes are at most every 10 s.
 */
import type { FalBalanceResponse } from "../../shared/api";
import type { AppConfig } from "../config";

export const FAL_BILLING_URL = "https://api.fal.ai/v1/account/billing?expand=credits";

const TTL_OK_MS = 60_000;
const TTL_ERROR_MS = 60_000;
const TTL_FORBIDDEN_MS = 10 * 60_000;
const MIN_REFRESH_GAP_MS = 10_000;
const TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class FalBalance {
  private cached: { at: number; ttl: number; value: FalBalanceResponse } | null = null;
  private inflight: Promise<FalBalanceResponse> | null = null;

  constructor(
    private readonly config: Pick<AppConfig, "providerMode" | "falKey" | "falBillingKey">,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly now: () => number = Date.now,
  ) {}

  /** The key used for the lookup, or null when nothing should be sent to fal. */
  private key(): string | null {
    if (this.config.providerMode !== "fal") return null; // mock mode sends nothing to fal
    return this.config.falBillingKey ?? this.config.falKey;
  }

  async get(refresh = false): Promise<FalBalanceResponse> {
    const key = this.key();
    if (!key) return { state: "off" };
    const c = this.cached;
    const age = c ? this.now() - c.at : Infinity;
    if (c && age < c.ttl && !(refresh && age >= MIN_REFRESH_GAP_MS)) return c.value;
    this.inflight ??= this.lookup(key).finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async lookup(key: string): Promise<FalBalanceResponse> {
    const checkedAt = new Date(this.now()).toISOString();
    const usingBillingKey = this.config.falBillingKey !== null;
    let value: FalBalanceResponse;
    let ttl = TTL_ERROR_MS;
    try {
      const res = await this.fetchImpl(FAL_BILLING_URL, {
        headers: { Authorization: `Key ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        ttl = TTL_FORBIDDEN_MS;
        value = {
          state: "unavailable",
          needsBillingKey: true,
          checkedAt,
          message: usingBillingKey
            ? `fal refused FAL_BILLING_KEY (HTTP ${res.status}). Check that it is current and has billing-read permission (the BILLING preset).`
            : `Your FAL_KEY can generate but can't read billing (HTTP ${res.status}). To show credits, create a read-only key with the BILLING preset in fal's dashboard and set FAL_BILLING_KEY in .env.`,
        };
      } else if (!res.ok) {
        value = { state: "unavailable", needsBillingKey: false, checkedAt, message: `fal's billing service answered HTTP ${res.status}. Will retry shortly.` };
      } else {
        const body = (await res.json()) as { credits?: { current_balance?: unknown; currency?: unknown } };
        const balance = body.credits?.current_balance;
        const currency = body.credits?.currency;
        if (typeof balance !== "number" || !Number.isFinite(balance)) {
          value = { state: "unavailable", needsBillingKey: false, checkedAt, message: "fal's billing response had no credit balance." };
        } else {
          ttl = TTL_OK_MS;
          value = { state: "ok", balance, currency: typeof currency === "string" && currency ? currency : "USD", checkedAt };
        }
      }
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      value = {
        state: "unavailable",
        needsBillingKey: false,
        checkedAt,
        message: timedOut ? "fal's billing service did not answer in time. Will retry shortly." : "Could not reach fal to check credits. Will retry shortly.",
      };
    }
    this.cached = { at: this.now(), ttl, value };
    return value;
  }
}
