/**
 * Tiny router. Path parameters are taken from the raw (still-encoded) path,
 * split on "/", and decoded exactly once per segment, so an encoded slash
 * (%2F, %5C) can never become a directory separator.
 */
import { decodeSegment } from "../films/paths";

export type Params = Record<string, string>;
export type Handler = (req: Request, params: Params, url: URL) => Promise<Response> | Response;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  put(p: string, h: Handler) { return this.add("PUT", p, h); }
  patch(p: string, h: Handler) { return this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  /** Returns the handler and params, "method" if the path exists with another method, or null. */
  match(method: string, rawPath: string): { handler: Handler; params: Params } | "method" | null {
    const segs = rawPath.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== segs.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const part = route.parts[i]!;
        const seg = segs[i]!;
        if (part.startsWith(":")) params[part.slice(1)] = seg;
        else if (part !== seg) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      const wantMethod = method === "HEAD" ? "GET" : method;
      if (route.method !== wantMethod) continue;
      // Decode only after a structural match; throws a 400 for malformed segments.
      const decoded: Params = {};
      for (const [k, v] of Object.entries(params)) decoded[k] = decodeSegment(v);
      return { handler: route.handler, params: decoded };
    }
    return pathMatched ? "method" : null;
  }
}
