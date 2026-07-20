<div align="center">

# Agora ⚖️

**An ethical-dilemma arena for language models.**
Pose a moral dilemma, poll *dozens* of AIs at once, watch a live consensus form —
then make the dissenters debate the majority and see who flips.

<!-- TODO: drop a screen-recording GIF here — it's the single best thing you can add.
     Record a full run (dilemma → consensus bar filling → TL;DR → Round 2 debate). -->
![Agora demo](./docs/demo.gif)

</div>

---

## What is this?

Everyone argues about how AI "thinks" about ethics. Agora just **asks them — at scale — and shows you.**

Give it a dilemma ("A runaway trolley is heading toward 5 workers… do you pull the lever?").
Agora fires that question at a whole pool of models across multiple providers, streams their
YES/NO votes in as they land, and builds a **live consensus bar**. Then it summarizes the
collective verdict — and, if the models disagree, runs a **Round 2** where minority-voters
argue it out with the majority and can actually change their minds.

It's a toy, a research probe, and a genuinely fun thing to share — all at once.

## How it works

A single run is a four-stage pipeline, all streamed to the browser over Server-Sent Events:

1. **Extract choices** — a model reads the dilemma and pins down the actual options (e.g. `YES` / `NO`).
2. **Poll the swarm** — the question is sent to many models (default **20** requests, spread
   across your configured providers). Each response streams back with a **vote**, its
   **reasoning**, and per-option notes. The **consensus bar** fills up live.
3. **TL;DR** — a synthesizer model streams a plain-English summary of where the crowd landed and why.
4. **Round 2 · The Debate** *(optional)* — Agora pairs each minority-voter against a random
   majority-voter. They argue for up to 5 turns; a model can **flip** its vote mid-debate, and
   the UI shows exactly who got persuaded. There's also a *symmetric* mode for a genuine
   two-way back-and-forth instead of pure persuasion.

Every run is saved to local **history**, so you can revisit or reload past debates.

## Features

- 🗳️ **Mass polling** — dozens of votes per dilemma, streamed live, no waiting on the slowest model
- 📊 **Live consensus bar** — see YES/NO (or N-way) support shift in real time
- 🔀 **Multi-provider by design** — mixes models from Cerebras, Groq, OpenRouter, Google, … with
  per-model rate limits, so free tiers keep serving instead of rate-limiting you
- 🥊 **Round 2 debates** — watch models persuade each other and flip votes
- 🧠 **10 built-in dilemmas** — classic trolley problems, transplant paradoxes, autonomous-car
  cases — or write your own
- 📜 **Run history** — every debate saved locally and reloadable
- ✨ Smooth, animated UI (framer-motion) built on Next.js

## Quickstart

Requires **Node 18+**.

```bash
npm install

# Configure your models (see below), then:
npm run dev        # http://localhost:3000
```

### Configuration

Agora reads a `config.yaml` describing your providers and models. **API keys live only in this
file, which is gitignored — nothing is hardcoded.** A minimal example:

```yaml
providers:
  - name: cerebras
    base_url: https://api.cerebras.ai/v1
    api_key: YOUR_CEREBRAS_KEY
    header_parser: openai_compatible
    models:
      - name: llama3.1-8b
        intelligence: 6
        rate_limits: { rpm: 30, tpm: 60000 }

  - name: groq
    base_url: https://api.groq.com/openai/v1
    api_key: YOUR_GROQ_KEY
    header_parser: openai_compatible
    models:
      - name: llama-3.3-70b-versatile
        intelligence: 7
        rate_limits: { rpm: 30, tpm: 12000 }
```

Add as many providers/models as you like — the more you add, the richer the consensus. Most
free AI tiers work great here.

## Tech

Next.js (App Router) · React + TypeScript · Tailwind CSS · framer-motion · streaming API routes
(Server-Sent Events) · YAML-driven multi-provider model config.

> Part of a small family of AI projects exploring resilient, multi-provider LLM tooling — the
> same routing idea powers [flexrouter](https://github.com/notnotnotnoone).

## License

[MIT](./LICENSE) © 2026 notnotnotnoone
