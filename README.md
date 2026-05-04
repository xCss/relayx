# relayx

Stateless dynamic request relay for CORS-safe forwarding on Cloudflare Workers.

`relayx` is intentionally thin. The caller puts the upstream URL in the request path, sends the upstream headers it needs, and `relayx` forwards the request without storing anything.

## Features

- Dynamic target URL in the path: `/https://api.example.com/v1/...`
- Optional explicit prefix: `/relay/https://api.example.com/v1/...`
- Browser CORS preflight handling
- Optional browser origin allowlist with `ALLOWED_ORIGINS`
- HTTPS-only upstream targets
- Caller-provided auth headers; no Worker-side API key injection
- No KV, D1, R2, Durable Objects, Queues, cache storage, logs, or persistence

## Quick start

Install dependencies:

```bash
pnpm install
```

Run locally:

```bash
pnpm dev
```

Send a test request through the local Worker:

```bash
curl -X POST 'http://localhost:8787/https://api.openai.com/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Request format

Put the full upstream URL after the Worker origin:

```txt
https://relayx.example.com/https://api.openai.com/v1/chat/completions
```

The `/relay/` prefix is also accepted if you prefer a clearer route:

```txt
https://relayx.example.com/relay/https://api.openai.com/v1/chat/completions
```

Query strings are preserved from the outer Worker URL:

```txt
https://relayx.example.com/https://api.openai.com/v1/chat/completions?stream=false
```

For an OpenAI-compatible frontend, set `BASE_URL` to the Worker URL plus the upstream base:

```txt
https://relayx.example.com/https://api.openai.com/v1
```

`relayx` does not append API endpoints automatically. If the client requests only the URL above, the upstream request also stops at `/v1`. OpenAI-compatible clients usually append paths such as `/chat/completions` themselves.

## Headers

Callers provide upstream headers directly. For OpenAI-compatible APIs, send headers such as:

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
OpenAI-Organization: OPTIONAL_ORG
OpenAI-Project: OPTIONAL_PROJECT
```

`relayx` forwards allowed request headers and adds CORS headers to responses. It strips browser/session and edge forwarding headers before upstream fetch:

- `Cookie`
- `CF-*`
- `X-Forwarded-*`
- `Host`
- `Access-Control-*`
- hop-by-hop headers such as `Connection` and `Transfer-Encoding`

## Optional CORS restriction

By default, `relayx` reflects any browser `Origin`. This is convenient for local testing and caller-supplied credentials.

To allow only specific browser origins, configure `ALLOWED_ORIGINS` in `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "ALLOWED_ORIGINS": "https://rpx.pages.dev, https://app.example.com"
  }
}
```

Requests from other browser origins receive `403`. Server-to-server requests without an `Origin` header are still allowed.

## Deploy

Log in to Cloudflare:

```bash
pnpm wrangler login
```

Deploy the Worker:

```bash
pnpm run deploy
```

Wrangler prints the deployed Worker URL, for example:

```txt
https://relayx.example.workers.dev
```

Use it as your AI base URL:

```txt
https://relayx.example.workers.dev/https://api.openai.com/v1
```

## Scripts

```bash
pnpm test       # run unit tests
pnpm typecheck  # run TypeScript checks
pnpm dev        # run locally with Wrangler
pnpm run deploy # deploy to Cloudflare Workers
```

## Design boundaries

`relayx` deliberately does not include:

- `UPSTREAM_BASE_URL`
- Worker-side API key injection
- request or response persistence
- request logging
- user accounts
- quota tracking
- model routing
- prompt or completion inspection

The Worker is a transport relay only.

## Troubleshooting

### `pnpm deploy` says workspace deploy is required

Use the package script instead:

```bash
pnpm run deploy
```

### Bash says `-H: command not found`

Use backslash (`\`) for line continuation in bash, not Windows `cmd` caret (`^`).

### Upstream returns `API_KEY_REQUIRED`

The upstream did not receive a valid auth header. Check that your request includes one of the headers required by that upstream, such as:

```http
Authorization: Bearer YOUR_API_KEY
```

### Upstream returns `Service temporarily unavailable`

The request reached the upstream service. Try the same request directly against the upstream URL to compare behavior.
