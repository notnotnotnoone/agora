# Handoff: Agora → flexrouter showcase

Written 27 Sep 2026, at the end of a cloud session, for a local session to pick up.
Cloud session: https://claude.ai/code/session_01Tf2bJDokRcFZyNtFdU4Ppr

**The decisions (§) win if anything else disagrees**, including code already on the branch.
Anything marked **OPEN** needs the owner's answer before it is built.
The owner's own words are in the [answer log](#answer-log) at the end.

---

## Where things are

| Repo | Branch | State |
|---|---|---|
| `notnotnotnoone/agora` | `claude/flexrouter-migration-version-2gelm7` | Pushed, **no PR**. Two commits on top of `master`: `dcdb2f1` (first migration) and `d430731` (full rebuild). Working tree clean. |
| `notnotnotnoone/flexrouter` | none yet | **Nothing written.** A branch `claude/requests-api` was created in the cloud sandbox only; never pushed, no changes. Start fresh from `master`. |

**Why a local session:** the cloud sandbox cannot run flexrouter's test suite. `tiktoken`
downloads `cl100k_base` from `openaipublic.blob.core.windows.net`, which that environment's
network policy blocks. Locally it just works (`uv run pytest -n auto`).

**Correction to the last cloud message:** it said some Agora files changed on disk after the
last commit. They didn't; those notices were the session's own committed edits. Nothing is lost.

---

## Decisions

### §1 Talk to flexrouter over HTTP, not the Python library
Agora is Next.js/TypeScript, so it cannot import the PIP `FlexRouter` class. It talks to a
running flexrouter server (`flexrouter serve` / `flexrouter dashboard`) through the
OpenAI-compatible `/v1` API.

### §2 This is a replacement, not an upgrade
The old Agora never used flexrouter. It had its own provider list with API keys in `../config.yaml`,
round-robin with retries, and no real rate limiting.
- It predates flexrouter: Agora's code is from 21–22 May 2026, flexrouter's first commit 27 May 2026.
- Its config format never matched any flexrouter version.
- The shared `header_parser` name is the only overlap.

So there is nothing to migrate. Keys get re-added with `flexrouter keys add`, and the model
list is rebuilt in flexrouter's shared config.

### §3 Agora holds no keys and knows no providers
All provider knowledge lives in flexrouter. Agora's settings are only:
- `FLEXROUTER_URL` (default `http://localhost:4891`)
- `FLEXROUTER_TOKEN` (flexrouter's `auth_token` / app password, if set)
- `FLEXROUTER_BUCKET` (default `auto`)
- `FLEXROUTER_DASHBOARD_URL`

### §4 Single models are addressed by `provider/model`
The owner's suggestion.
- `/v1/models` lists buckets, then `auto`, then every model under its `provider/model` id,
  with score, limits and live status.
- Sending that id as `model` pins the request to exactly that model (ADR 0009).
- A pinned request **does not fail over**: busy or broken fails immediately.

### §5 Agora is a showpiece for flexrouter
That is the project's purpose from now on. Choices are judged by how well they show off
flexrouter.

### §6 Overhaul the project
The owner: "this project employs a lot of shitty practices". The practices found and fixed on the branch:
- **It didn't build.** Half the frontend was never committed.
- **One 450-line page.** 17 `useState`s, with the API calls and stream parsing inside the component.
- **Copied stream parser.** Duplicated four times, and it dropped events split across network chunks.
- **Nothing actually streamed.** Votes appeared only once each model had finished.
- **Debate reasoning was always empty.**
- **Aborted runs were saved to history.**
- **Unvalidated input.**
- **Hygiene.** No tests, no CI, a vulnerable Next.js version, create-next-app leftovers.

### §7 Rebuild the frontend from scratch
These files were imported but exist in no repo:
- `consensus-bar`, `model-response-list`, `tldr-panel`, `button`, `textarea`
- `lib/choice-colors`, `lib/questions`, `lib/config-loader`
- the routes `/api/models`, `/api/extract-choices`, `/api/tldr`

The owner chose "Rebuild from scratch" over pushing local copies.

### §8 What Agora puts on display
The owner picked all four, plus the request log:
1. **Live routing panel:** every model's flexrouter status (ready / cooling down with countdown / needs you / off) and what it is doing in this run.
2. **Failover visible per vote:** which models were tried and skipped before one answered.
3. **Cost / free-tier meter:** flexrouter's spend (`$0.00` on free tiers) and tokens per provider.
4. **Provider mix:** votes and tokens per provider, which shows free tiers being pooled.
5. **The request log, copied over from flexrouter directly** (the owner's addition). See §10.

### §9 Routing is a hybrid (**OPEN: the no-repeat rule**)
- **The owner's first answer:** "Hybird, just make sure the same model dosent show up 2 or more times".
- **Then:** "Scratch that last one, just do a hybrid system like u suggested".
- **The proposed hybrid:**
  - Each vote asks a **bucket**, and **excludes the models that have already voted**.
  - flexrouter picks the model and does the failover itself, so it shows up in its own trace/journey.
  - Agora only tracks who has voted, and stops running its own retry loop.
- **OPEN:** does "scratch that last one" mean
  - (a) models *may* vote more than once, so no exclude list is needed, or
  - (b) keep one-vote-per-model, but let flexrouter do the picking via the exclude list?

  §11.3 depends on this. Ask before building it.
- **What the branch has now** (to be replaced): each vote is pinned to one model, and Agora
  moves the vote to the next unused model on failure, interleaving providers.

### §10 No duplicated code: flexrouter exposes the request log
The owner's proposal. Agora's rebuild re-implemented the request log from its own call
records; that goes. flexrouter gets JSON endpoints for its existing request data, and Agora
reads them. Agora then also shows real failovers, which it cannot see today: flexrouter only
reports failed attempts on a *failed* response, never on a successful stream.

### §11 The flexrouter PR (Claude writes it)
The owner: "u write the flexrouter endpoints in a PR".

1. **`GET /api/requests`**: recent requests as JSON, newest first.
   - Filters: `client`, `result` (`ok`/`failover`/`failed`), `bucket`, `provider`, `q`, `limit`.
   - Returns `{"requests": [...], "total": n}`.
   - Reuse `dashboard/facts.recent_requests` and `dashboard/requests_page.filtered`.
   - Add a `client` field to `RequestRow`.
2. **`GET /api/requests/{id}`**: one request's journey (skipped → failed attempts → answered / gave up).
   - Reuse `facts.request_journey`.
   - 404 when unknown.
3. **Client tag:** an `X-Flexrouter-Client` header on `/v1/chat/completions`.
   - `app.py` reads it and validates it: trimmed, length-capped, safe character set.
   - It is passed to `agenerate` / `agenerate_stream` as a **new explicit `client=` keyword** and stored in the trace (in `asked`).
   - It must **not** travel in `**kwargs`: those are forwarded to the provider.
   - It is a header and **not** the OpenAI `user` body field, because `user` is already in `_PASSTHROUGH` and reaches providers.
   - Agora sends `agora-<run-id>`, so its log shows only its own run.
4. **Per-request exclude list:** only if §9 resolves to (b).
   - The engine already takes `exclude` internally (`engine.py`, used for models tried in this request).
   - This exposes it on the request, e.g. a body field or header naming `provider/model`s to leave out of a bucket call.
   - Decide the wire shape in the PR and record it in an ADR (flexrouter keeps ADRs in `docs/adr/`).
5. **Where the endpoints live:** under `/api`, next to the dashboard's other data.
   - Per ADR 0009, `/api` is open on the local machine and only `/v1` is guarded by `auth_token`.
   - Follow that. Don't add a new guard.
6. **Tests:**
   - Follow `tests/test_dashboard_requests.py` (write trace lines, then query).
   - Follow `tests/test_trace_e2e.py` (a real request through the HTTP surface leaves a trace carrying the client tag).
   - Run `uv run pytest -n auto`. Run `uv run pytest -m browser` only if dashboard JS or markup changes.
7. **The PR:** follow `.github/PULL_REQUEST_TEMPLATE.md` ("What this changes", "How it was tested", checklist).
   - Update `docs/5-API-Reference.md` for the new endpoints and header.

### §12 Then Agora switches over
After §11 merges (or against its branch):
- **The request log** reads `GET /api/requests?client=agora-<run-id>`, and the journey panel reads `GET /api/requests/{id}`.
- **Delete** Agora's own `CallRecord` building (`callRecord()` in `src/lib/server/flexrouter.ts`, the `call` events, `state.calls`).
- **Vote scheduling** changes to §9's hybrid once §9 is answered.
- **Failover chains on vote cards** come from flexrouter's journeys instead of Agora's retry loop.
- **Keep from the branch:**
  - one SSE stream per round (`/api/run`, `/api/debate`)
  - the reducer (`src/lib/arena.ts`)
  - the shared SSE parser (`src/lib/sse.ts`)
  - prompts and parsers with their tests
  - the flexrouter-styled CSS
  - validation, CI

### §13 Plan before building
The owner stopped the session: "why are we not even like making a plan or anything?" Work of
this size (two repos, most of an app) gets a written plan the owner sees *before* code.
Each step here should be shown to the owner before it starts.

### §14 Hand off to a local session
The owner asked for this. It's why this file exists (see "Why a local session").

---

## Choices Claude made on the branch without an explicit yes

Treat these as proposals. They are in `d430731`, and the owner has not signed off on any of them.

- **Dependencies:**
  - Next.js 16.2.6 → **16.3.6** (security fixes; `npm audit` clean), Node **20.9+**, TS target ES2022.
  - **Dropped Tailwind and framer-motion.**
  - Styling is flexrouter's dashboard design, ported: its colour tokens, boxes, tags, tables, and its Geist fonts copied into `src/app/fonts/`.
- **Server shape:**
  - `/api/run` streams the whole of round 1 (options → votes → TL;DR).
  - `/api/debate` streams round 2.
  - `/api/flexrouter` gives the live roster + spend for the panels.
- **Model calls:**
  - Options are extracted through the bucket `FLEXROUTER_BUCKET` (default `auto`).
  - The TL;DR comes from the first of the top-3 models by score that answers.
- **Round 2:**
  - One argument and one reply per pair, persuaders shared out round-robin.
  - The old README's "up to 5 turns" and "symmetric mode" were **not** rebuilt: the committed code only ever did one exchange.
- **Limits:**
  - up to 60 votes, 12 debate pairs
  - 6 votes / 4 debates in flight
  - question ≤ 4000 characters
- **History:** a new IndexedDB database `agora` holding the last 100 runs.
  - Runs saved by the old version are not shown.
- **Request log outcomes are only OK / FAILED.** The "Failover" filter was dropped because Agora can't see failovers today (§10 fixes that; bring it back then).
- **Tests and CI:** vitest (57 tests), plus a CI workflow running lint → typecheck → test → build.
- **README screenshot** (`docs/screenshot.png`) is from mock providers and is captioned as such.
  - Replace it with a real run.
  - The old README's `demo.gif` never existed.

---

## Facts learned about flexrouter (so nobody re-derives them)

- **Where errors come from.** A **stream fails inside HTTP 200**: flexrouter sends `data: {"error": {...}}` inside the stream. A **non-stream** error is a normal HTTP error. Either way `error.flexrouter` carries `request_id` and `attempts` (`model`, `status`, `provider_message`, `verdict`, `ms`, `waited_ms`).
- **Request id header.** Every response carries `x-flexrouter-request-id`, which is the trace id.
- **Streamed chunks don't name the serving model.** Their `model` is whatever the caller asked for, so a bucket call's stream does not say which model answered. The trace does (`answered_by`).
- **Pinned calls don't fall back.** A busy or broken pinned model fails at once.
- **Rate limits are per key.** One model's 429 can mark the whole key busy, so other models on the same key are refused too. This was seen in testing (groq).
- **Existing read endpoints:**
  - `/v1/models`: status per model (`value`, `reason`, `until`).
  - `/api/status`: `total_cost_usd`, per-provider daily cost.
  - `/api/statuses`: models that aren't ready.
  - The Requests page is server-rendered HTML only; hence §11.
- **Traces** are `state/traces.jsonl`, one JSON object per request.
  - Fields: `id`, `at`, `asked{bucket,stream,needs,approx_input_tokens}`, `skipped[]`, `attempts[]`, `answered_by`, `tokens{in,out}`, `ms_total`, `ms_to_first_token`, `ok`.
  - The file rotates daily and is scrubbed on write (ADR 0010).

---

## Open questions for the owner (answered 26 Sep 2026, local session)

1. **§9 → (b) one vote per model.** Each vote asks a bucket with an exclude list of the models that already voted; flexrouter picks and fails over. §11.4 (the exclude list + ADR) is in scope.
2. **Hold** Agora's branch until §12 is done; one PR when it works end to end.
3. **Keep** the unapproved choices, **except: restore the 5-turn and symmetric debate modes.**
4. flexrouter's 8 unpushed local commits (Sessions 7/9/10): **fix, then push**. Pushed as `415f617`, with fixes for the two tests they broke (a model-level 403 marked the whole key Needs you, against ADR 0016; `set-retired` had no CSS rule). Three failures already on GitHub `master` remain: `test_page_links_every_area`, `test_a_429_is_classified_as_too_fast`, `test_a_provider_failure_is_recorded_as_an_attempt`.

Local note: run tests with `uv run python -m pytest -n auto`; `uv run pytest` fails with "trampoline failed to canonicalize script path" since the repo folder was renamed.

---

## Answer log

The owner's words, verbatim, in order.

1. "Hey, I want to work on migrating this app to the newer version of flexrouter. Should we use the PIP version or the dashboard version?"
2. "Flexrouter has support for single models as well, with the /models endpoint?"
3. "Wait a minute, does the current code use its own proprietary system or an older version of flexrouter"
4. "Ok, let's migrate over"
5. "This projects employs a lot of shitty practices, let's overhaul this. This project is mainly gonna be a showpiece for the potential of flexrouter"
6. Grill answers:
   - Frontend → "Rebuild from scratch (Recommended)"
   - Showcase → "Live routing panel, Failover visible per vote, Cost / free-tier meter, Provider mix breakdown, I want the requests log copied over from the flexrouter repo directly"
   - Routing → "Hybird, just make sure the same model dosent show up 2 or more times and it's good"
7. "Scratch that last one, just do a hybrid system like u suggested / Hey, I own both repos if u want me to setup endpoints for anything, I will / Why don't I just expose an endpoint for the requests stack, just so we don't have to Repete code? / STOP, WOAH, why are we not even like making a plan or anything? Is the task at hand small or smth?"
8. "u write the flexrouter endpoints in a PR"
9. "Hey, do you want to handoff to a local session?"
10. "MAKE ME A HANDOFF FILE WITH A LIST OF EVERYTHING WE DECIDED, LIKE IN THE GRILL, AND STUFF"
11. (local session) §9 → "One vote per model"; flexrouter → "Push them, then branch"; Agora → "Hold until §12"; choices → "Restore 5-turn/symmetric"; the two broken tests → "Fix both, then push".
