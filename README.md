<div align="center">

# Agora

**Ask a moral dilemma to every free-tier model you have at once, and watch them vote.**

A showcase for [flexrouter](https://github.com/notnotnotnoone/flexrouter): one local address in
front of Groq, Cerebras, OpenRouter, Google AI Studio and the rest, pooling their free tiers
and failing over when one runs dry.

![Agora after a run: consensus, votes with their failover chains, live routing, provider mix and the request log](./docs/screenshot.png)

<sub>Screenshot from a local test setup with mock providers.</sub>

</div>

---

## What it does

1. **Reads the dilemma.** A model picks out the options (`YES` / `NO`, or up to six others),
   asked through a flexrouter *bucket*, so flexrouter chooses the model and fails over on its own.
2. **Polls the crowd.** Each vote is pinned to a *different* model; no model votes twice.
   Votes are spread across providers in turn, so one provider's rate limit doesn't take out
   several votes at once. When a model is rate-limited, down, or answers off-format, the vote
   moves on to the next unused model, and the card shows the chain: `✕ llama-3.1-8b → ● qwen-3-32b`.
3. **Summarizes.** One of the best-scoring models writes a TL;DR, streamed live.
4. **Round 2.** Each minority voter faces a majority voter: one argument, one reply, and a
   chance to change its vote. Each side is argued by the model that cast that vote.

Everything streams to the browser as it happens, and finished runs are saved in the browser.

## What it shows off

| Panel | flexrouter feature |
|---|---|
| **Routing** | Every model flexrouter knows, with its live status (ready, cooling down with a countdown, needs a key) from `/v1/models`, and what each is doing in this run. |
| **Votes** | Per-model routing: `provider/model` names pin a request to one model. The failover chain on each card is Agora moving on when flexrouter reports a model busy. |
| **Provider mix** | Free-tier pooling: votes and tokens per provider. |
| **Spent** | flexrouter's spend tracking, from `/api/status`. On free tiers, `$0.00`. |
| **Requests** | A port of flexrouter's own Requests page: every call Agora made, its flexrouter request id, tokens, latency and outcome. Click a row for its journey (each failed attempt with the provider's message) and a link to the full trace in flexrouter's dashboard. |

## Quickstart

Requires **Node 20.9+** and **Python 3.11+**.

```bash
# 1. flexrouter: install, add models to its config.yaml, save keys, start it
pip install git+https://github.com/notnotnotnoone/flexrouter.git
flexrouter doctor            # prints where its config.yaml lives
flexrouter keys add groq     # once per provider
flexrouter serve             # http://localhost:4891

# 2. Agora
npm install
npm run dev                  # http://localhost:3000
```

Agora uses every model in flexrouter's config, so the more free-tier models you add there,
the bigger the crowd. See flexrouter's
[free tier stacking](https://github.com/notnotnotnoone/flexrouter#free-tier-stacking) section
for a starting list.

### Settings

All optional; put them in `.env.local` (see [`.env.example`](./.env.example)).

| Variable | Default | What it does |
|---|---|---|
| `FLEXROUTER_URL` | `http://localhost:4891` | Where flexrouter is running |
| `FLEXROUTER_TOKEN` | none | flexrouter's `auth_token` or dashboard password, if set |
| `FLEXROUTER_BUCKET` | `auto` | Bucket used to read a dilemma's options |
| `FLEXROUTER_DASHBOARD_URL` | `FLEXROUTER_URL` | Where the browser opens flexrouter's dashboard |

## How it's built

```
src/
  app/
    api/run/route.ts          round 1 as one SSE stream: options → votes → TL;DR
    api/debate/route.ts       round 2 as an SSE stream
    api/flexrouter/route.ts   live roster and spend, polled by the page
    page.tsx, layout.tsx, globals.css
  lib/
    server/flexrouter.ts      the only code that talks to flexrouter
    server/run.ts             vote scheduling: one model per vote, failover, summary
    server/debate.ts          round 2
    server/validate.ts        request body checks
    prompts.ts                every prompt, and the parsers for the replies
    arena.ts                  the page's state, as a reducer over server events
    sse.ts                    SSE encode/decode, shared by server and browser
  hooks/                      useArena (runs the streams), useFlexrouter (polling)
  components/                 one file per panel
```

Agora holds no API keys and knows nothing about any provider: flexrouter does all of that.
The styling is flexrouter's dashboard design, ported, so the two read as one product.

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## License

[MIT](./LICENSE) © 2026 notnotnotnoone
