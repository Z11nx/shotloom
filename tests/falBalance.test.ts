import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FAL_BILLING_URL, FalBalance } from "../server/system/falBalance";
import { req, testApp } from "./helpers";

/** Fake fetch: records calls and answers from a queue. Never touches the network. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a instanceof Error) throw a;
    return a.clone();
  };
  return { fn, calls };
}
const ok = (balance: unknown, currency: unknown = "USD") =>
  new Response(JSON.stringify({ username: "me", credits: { current_balance: balance, currency } }), { status: 200 });
const status = (code: number) => new Response(JSON.stringify({ error: { type: "x", message: "secret-ish detail" } }), { status: code });
const fal = (falKey: string | null, falBillingKey: string | null = null) => ({ providerMode: "fal" as const, falKey, falBillingKey });

describe("fal credit balance", () => {
  test("mock mode and a missing key send nothing to fal", async () => {
    const f = fakeFetch(ok(10));
    expect(await new FalBalance({ providerMode: "mock", falKey: "k", falBillingKey: "b" }, f.fn).get()).toEqual({ state: "off" });
    expect(await new FalBalance(fal(null), f.fn).get(true)).toEqual({ state: "off" });
    expect(f.calls.length).toBe(0);
  });

  test("reads the balance with FAL_KEY, from fal's documented endpoint", async () => {
    const f = fakeFetch(ok(24.5, "USD"));
    const r = await new FalBalance(fal("gen-key"), f.fn).get();
    expect(r).toMatchObject({ state: "ok", balance: 24.5, currency: "USD" });
    expect(f.calls).toEqual([{ url: FAL_BILLING_URL, auth: "Key gen-key" }]);
    expect(FAL_BILLING_URL).toBe("https://api.fal.ai/v1/account/billing?expand=credits");
  });

  test("prefers FAL_BILLING_KEY when set", async () => {
    const f = fakeFetch(ok(3));
    await new FalBalance(fal("gen-key", "billing-key"), f.fn).get();
    expect(f.calls[0]!.auth).toBe("Key billing-key");
  });

  test("caches for a minute; refresh is honored at most every 10 s; concurrent reads share one request", async () => {
    let t = 1_000_000;
    const f = fakeFetch(ok(5), ok(4), ok(3));
    const b = new FalBalance(fal("k"), f.fn, () => t);
    const [a1, a2] = await Promise.all([b.get(), b.get()]);
    expect(a1).toEqual(a2);
    expect(f.calls.length).toBe(1);
    t += 5_000;
    expect(await b.get(true)).toMatchObject({ balance: 5 }); // too soon to refresh
    expect(f.calls.length).toBe(1);
    t += 6_000;
    expect(await b.get(true)).toMatchObject({ balance: 4 }); // refresh allowed
    expect(await b.get()).toMatchObject({ balance: 4 }); // cached
    t += 61_000;
    expect(await b.get()).toMatchObject({ balance: 3 }); // expired
    expect(f.calls.length).toBe(3);
  });

  test("a key without billing permission explains FAL_BILLING_KEY and never echoes keys or fal's text", async () => {
    for (const code of [401, 403]) {
      const r = await new FalBalance(fal("gen-key-123"), fakeFetch(status(code)).fn).get();
      expect(r).toMatchObject({ state: "unavailable", needsBillingKey: true });
      const text = JSON.stringify(r);
      expect(text).toContain("FAL_BILLING_KEY");
      expect(text).not.toContain("gen-key-123");
      expect(text).not.toContain("secret-ish");
    }
    const r = await new FalBalance(fal("gen", "bill-key-9"), fakeFetch(status(403)).fn).get();
    expect(r).toMatchObject({ state: "unavailable", needsBillingKey: true });
    expect(JSON.stringify(r)).not.toContain("bill-key-9");
  });

  test("server errors, network failures and odd bodies are reported, not thrown", async () => {
    expect(await new FalBalance(fal("k"), fakeFetch(status(500)).fn).get()).toMatchObject({ state: "unavailable", needsBillingKey: false });
    expect(await new FalBalance(fal("k"), fakeFetch(new TypeError("fetch failed")).fn).get()).toMatchObject({ state: "unavailable", needsBillingKey: false });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(await new FalBalance(fal("k"), fakeFetch(timeout).fn).get()).toMatchObject({ state: "unavailable", message: expect.stringMatching(/in time/) });
    expect(await new FalBalance(fal("k"), fakeFetch(ok("lots")).fn).get()).toMatchObject({ state: "unavailable" });
    expect(await new FalBalance(fal("k"), fakeFetch(ok(Infinity)).fn).get()).toMatchObject({ state: "unavailable" });
  });

  test("an error is retried after its cache expires", async () => {
    let t = 0;
    const f = fakeFetch(status(500), ok(7));
    const b = new FalBalance(fal("k"), f.fn, () => t);
    expect((await b.get()).state).toBe("unavailable");
    t += 61_000;
    expect(await b.get()).toMatchObject({ state: "ok", balance: 7 });
  });

  test("GET /api/fal/balance returns the numbers only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shotloom-bal-"));
    const f = fakeFetch(ok(12.34));
    const config = { providerMode: "fal" as const, falKey: "route-secret", falBillingKey: null };
    const app = testApp(root, { falBalance: new FalBalance(config, f.fn) }, { GENERATION_PROVIDER: "fal", FAL_KEY: "route-secret" });
    const r = await app.fetch(req("GET", "/api/fal/balance?refresh=1"));
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("route-secret");
    expect(JSON.parse(text)).toMatchObject({ state: "ok", balance: 12.34, currency: "USD" });
  });

  test("the default app in mock mode reports off", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shotloom-bal-"));
    const r = await testApp(root, {}, { FAL_KEY: "x" }).fetch(req("GET", "/api/fal/balance"));
    expect(await r.json()).toEqual({ state: "off" });
  });
});
