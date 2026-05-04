import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("relayx worker", () => {
  it("answers CORS preflight without calling upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const request = new Request("https://relayx.example/https://api.example.test/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        Origin: "https://rpx.pages.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization"
      }
    });

    const response = await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://rpx.pages.dev");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("content-type, authorization");
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  it("forwards requests to the target URL encoded in the path", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const body = JSON.stringify({ model: "demo", messages: [{ role: "user", content: "Hi" }] });
    const request = new Request("https://relayx.example/https://api.example.test/v1/chat/completions?stream=false", {
      method: "POST",
      headers: {
        Origin: "https://rpx.pages.dev",
        "Content-Type": "application/json",
        Authorization: "Bearer caller-key",
        "OpenAI-Organization": "org-demo"
      },
      body
    });

    const response = await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, fetcher);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://rpx.pages.dev");
    expect(response.headers.get("Content-Type")).toContain("application/json");

    expect(fetcher).toHaveBeenCalledOnce();
    const forwarded = fetcher.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://api.example.test/v1/chat/completions?stream=false");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("Authorization")).toBe("Bearer caller-key");
    expect(forwarded.headers.get("Content-Type")).toBe("application/json");
    expect(forwarded.headers.get("OpenAI-Organization")).toBe("org-demo");
    expect(await forwarded.text()).toBe(body);
  });

  it("also accepts a /relay/ prefix before the target URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const request = new Request("https://relayx.example/relay/https://api.example.test/v1/models");

    const response = await worker.fetch(request, {}, undefined, fetcher);

    expect(response.status).toBe(200);
    const forwarded = fetcher.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://api.example.test/v1/models");
  });

  it("rejects browser requests from origins outside ALLOWED_ORIGINS", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const request = new Request("https://relayx.example/https://api.example.test/v1/models", {
      headers: { Origin: "https://evil.example" }
    });

    const response = await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Origin is not allowed" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });

  it("allows browser requests from comma-separated ALLOWED_ORIGINS", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const request = new Request("https://relayx.example/https://api.example.test/v1/models", {
      headers: { Origin: "https://app.example" }
    });

    const response = await worker.fetch(
      request,
      { ALLOWED_ORIGINS: "https://rpx.pages.dev, https://app.example" },
      undefined,
      fetcher
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
  });

  it("strips sensitive browser and edge headers before forwarding", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const request = new Request("https://relayx.example/https://api.example.test/v1/models", {
      headers: {
        Origin: "https://rpx.pages.dev",
        Cookie: "session=secret",
        "CF-Connecting-IP": "203.0.113.1",
        "X-Forwarded-For": "203.0.113.1"
      }
    });

    await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, fetcher);

    const forwarded = fetcher.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.has("Cookie")).toBe(false);
    expect(forwarded.headers.has("CF-Connecting-IP")).toBe(false);
    expect(forwarded.headers.has("X-Forwarded-For")).toBe(false);
  });

  it("rejects requests without a target URL", async () => {
    const request = new Request("https://relayx.example/", {
      headers: { Origin: "https://rpx.pages.dev" }
    });

    const response = await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, vi.fn<typeof fetch>());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Target URL is required" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://rpx.pages.dev");
  });

  it("rejects non-HTTPS target URLs", async () => {
    const request = new Request("https://relayx.example/http://api.example.test/v1/models", {
      headers: { Origin: "https://rpx.pages.dev" }
    });

    const response = await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, vi.fn<typeof fetch>());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Target URL must use https" });
  });

  it("returns a CORS-safe error when upstream fetch fails", async () => {
    const request = new Request("https://relayx.example/https://api.example.test/v1/models", {
      headers: { Origin: "https://rpx.pages.dev" }
    });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));

    const response = await worker.fetch(request, { ALLOWED_ORIGINS: "https://rpx.pages.dev" }, undefined, fetcher);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Unable to reach upstream" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://rpx.pages.dev");
  });
});
