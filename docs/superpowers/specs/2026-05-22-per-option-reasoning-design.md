# Per-Option Reasoning Design

**Date:** 2026-05-22  
**Status:** Approved

## Problem

The AI currently produces free-form `REASONING:` text before picking an `ANSWER:`. Models can be vague and skip mentioning why they rejected other options. The user wants every option explicitly evaluated — chosen or not — with specific, non-generic reasoning.

## Solution

Replace the free-form `REASONING:` block with a mandatory structured `OPTION [Name]:` block per choice, followed by the `ANSWER:` line.

## New Response Format

```
OPTION [OptionA]: <specific reason why you would or would not choose this>
OPTION [OptionB]: <specific reason why you would or would not choose this>
...one block per option...
ANSWER: <exactly one of the listed options verbatim>
```

## Changes

### 1. `src/app/api/run/route.ts` — `buildSystemPrompt`

- Remove the `REASONING:` instruction.
- For each choice, inject a labeled `OPTION [X]:` line in the required format template.
- Add explicit instruction: "You MUST write an OPTION block for every choice listed. Do not skip any option. Each block must give a specific, concrete reason — not vague platitudes."

### 2. `src/app/api/run/route.ts` — `parseResponse`

- Remove `REASONING:` extraction.
- Extract all `OPTION [X]:` blocks into a `Record<string, string>` map keyed by option name.
- Keep `ANSWER:` extraction unchanged.
- Return `{ vote, optionReasons }` instead of `{ vote, reasoning }`.

### 3. `src/lib/types.ts` — `ResponseEntry`

- Add `optionReasons: Record<string, string>` field.
- Keep `reasoning: string` for backward compatibility with the debate route (which uses its own prompt/parser).

### 4. `src/app/api/run/route.ts` — SSE emission

- In the `response_done` event, send `optionReasons` alongside `vote`.
- Keep `reasoning` as empty string for run-route responses (debate route still populates it).

### 5. `src/lib/types.ts` — `RunEvent`

- Add `optionReasons: Record<string, string>` to the `response_done` event type.

### 6. `src/components/ui/model-response-card.tsx`

- Replace the single collapsed reasoning blob with one labeled row per option.
- Chosen option row: highlighted with the existing badge color.
- Rejected option rows: muted text style.
- Each row shows the model's specific reason for that option.
- Expand/collapse behavior: collapse all option rows together (same trigger as before).

## Out of Scope

- The debate route (`/api/debate`) keeps its existing prompt and `reasoning` field — no changes.
- The TLDR route is unaffected.
