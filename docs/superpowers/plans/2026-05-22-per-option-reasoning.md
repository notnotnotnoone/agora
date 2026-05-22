# Per-Option Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Force the AI to explicitly state why it chose or rejected every option, displayed as labeled per-option rows in the UI.

**Architecture:** Change the system prompt to require one `OPTION [Name]:` block per choice before `ANSWER:`. Update the parser to extract these into a `Record<string, string>`. Propagate `optionReasons` through the SSE event, page state, and component.

**Tech Stack:** Next.js App Router, TypeScript, SSE streaming, Framer Motion, Tailwind CSS

---

### Task 1: Add `optionReasons` to types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add `optionReasons` to `ResponseEntry` and `RunEvent`**

Open `src/lib/types.ts`. Make these two changes:

In `ResponseEntry`, add the new field after `reasoning`:
```typescript
export interface ResponseEntry {
  modelId: string;
  requestIndex: number;
  status: "pending" | "streaming" | "done" | "failed";
  reasoning: string;
  optionReasons: Record<string, string>;
  vote: string | null;
  rawText: string;
  error?: string;
}
```

In `RunEvent`, update the `response_done` variant to include `optionReasons`:
```typescript
export type RunEvent =
  | { type: "response_start"; modelId: string; requestIndex: number }
  | { type: "response_token"; modelId: string; requestIndex: number; token: string }
  | { type: "response_done"; modelId: string; requestIndex: number; vote: string | null; reasoning: string; optionReasons: Record<string, string> }
  | { type: "response_error"; modelId: string; requestIndex: number; error: string }
  | { type: "all_done" };
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add optionReasons to ResponseEntry and RunEvent types"
```

---

### Task 2: Update system prompt and parser in the run route

**Files:**
- Modify: `src/app/api/run/route.ts`

- [ ] **Step 1: Replace `buildSystemPrompt`**

Replace the entire `buildSystemPrompt` function with:

```typescript
function buildSystemPrompt(choices: string[]): string {
  const list = choices.join(", ");
  const optionLines = choices.map((c) => `OPTION [${c}]: <specific reason why you would or would not choose this option>`).join("\n");
  return `You are answering a moral dilemma question. Think through every available option carefully.

You MUST format your response EXACTLY as follows — one OPTION block per choice, then ANSWER:

${optionLines}
ANSWER: <one of: ${list}>

Rules:
- You MUST write an OPTION block for EVERY option listed above. Do not skip any.
- Each OPTION block must give a specific, concrete reason — not vague platitudes like "this seems right". Explain the actual moral reasoning for choosing or rejecting that option.
- The ANSWER line must contain exactly one of the listed options verbatim: ${list}.`;
}
```

- [ ] **Step 2: Replace `parseResponse`**

Replace the entire `parseResponse` function with:

```typescript
function parseResponse(
  text: string,
  choices: string[]
): { vote: string | null; optionReasons: Record<string, string> } {
  const answerMatch = text.match(/ANSWER:\s*(.+?)[\r\n]*$/im);
  const rawAnswer = answerMatch ? answerMatch[1].trim() : null;
  const vote = rawAnswer
    ? (choices.find((c) => c.toLowerCase() === rawAnswer.toLowerCase()) ?? null)
    : null;

  const optionReasons: Record<string, string> = {};
  for (const choice of choices) {
    const escaped = choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`OPTION\\s*\\[${escaped}\\]:\\s*([\\s\\S]*?)(?=\\nOPTION\\s*\\[|\\nANSWER:|$)`, "i");
    const match = text.match(pattern);
    optionReasons[choice] = match ? match[1].trim() : "";
  }

  return { vote, optionReasons };
}
```

- [ ] **Step 3: Update `trySingleRequest` return type and call site**

Replace the `trySingleRequest` function signature and body to use `optionReasons` instead of `reasoning`:

```typescript
async function trySingleRequest(
  model: ModelConfig,
  question: string,
  choices: string[]
): Promise<{ vote: string; optionReasons: Record<string, string> } | null> {
  try {
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(model),
      body: JSON.stringify({
        model: model.modelName,
        messages: [
          { role: "system", content: buildSystemPrompt(choices) },
          { role: "user", content: question },
        ],
        stream: true,
        temperature: 0.9,
      }),
    });

    if (!res.ok || !res.body) return null;

    let fullText = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(jsonStr);
          const token: string = parsed?.choices?.[0]?.delta?.content ?? "";
          if (token) fullText += token;
        } catch {
          // skip malformed lines
        }
      }
    }

    const { vote, optionReasons } = parseResponse(fullText, choices);
    if (!vote) return null;
    return { vote, optionReasons };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update the SSE `response_done` emission**

In the `worker` function inside `start(controller)`, replace the two `send` calls that fire on success:

```typescript
if (result !== null) {
  validCount++;
  send({ type: "response_start", modelId: model.id, requestIndex: mySlot });
  send({
    type: "response_done",
    modelId: model.id,
    requestIndex: mySlot,
    vote: result.vote,
    reasoning: "",
    optionReasons: result.optionReasons,
  });
  if (validCount >= targetCount) finish();
  succeeded = true;
  break;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/run/route.ts
git commit -m "feat: update run route to require per-option reasoning blocks"
```

---

### Task 3: Update page.tsx to propagate `optionReasons`

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Update `response_start` entry initialisation**

In `handleRun`, find the `response_start` handler and add `optionReasons: {}`:

```typescript
if (event.type === "response_start") {
  const newEntry: ResponseEntry = {
    modelId: event.modelId,
    requestIndex: event.requestIndex,
    status: "pending",
    reasoning: "",
    optionReasons: {},
    vote: null,
    rawText: "",
  };
  setResponses((prev) => [...prev, newEntry]);
}
```

- [ ] **Step 2: Update `response_done` handler**

Find the `response_done` handler. Update the `setResponses` map call and the `collectedResponses.push`:

```typescript
} else if (event.type === "response_done") {
  setResponses((prev) =>
    prev.map((r) =>
      r.modelId === event.modelId && r.requestIndex === event.requestIndex
        ? { ...r, status: "done", vote: event.vote, reasoning: event.reasoning, optionReasons: event.optionReasons }
        : r
    )
  );
  const updated: ResponseEntry = {
    modelId: event.modelId,
    requestIndex: event.requestIndex,
    status: "done",
    vote: event.vote,
    reasoning: event.reasoning,
    optionReasons: event.optionReasons,
    rawText: "",
  };
  collectedResponses.push(updated);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: propagate optionReasons through page state"
```

---

### Task 4: Update the response card UI

**Files:**
- Modify: `src/components/ui/model-response-card.tsx`

- [ ] **Step 1: Replace `ResponseRow` with per-option layout**

Replace the entire `ResponseRow` component with this version that renders one row per option instead of a single reasoning blob:

```typescript
function ResponseRow({
  response,
  choices,
}: {
  response: ResponseEntry;
  choices: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  const badgeColor =
    response.vote
      ? BADGE_COLORS[choiceIndex(response.vote, choices)]
      : "bg-muted text-muted-foreground";

  const hasOptionReasons =
    response.status === "done" &&
    response.optionReasons &&
    Object.keys(response.optionReasons).length > 0;

  return (
    <motion.li
      className="flex flex-col py-0.5 pl-6"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 25 }}
    >
      <motion.div
        className="flex flex-1 items-center rounded-md p-1 cursor-pointer"
        onClick={() => hasOptionReasons && setExpanded((p) => !p)}
        whileHover={{ backgroundColor: "rgba(0,0,0,0.03)" }}
      >
        <div className="mr-2">
          <AnimatePresence mode="wait">
            <motion.div
              key={response.status + String(response.vote)}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
            >
              <StatusIcon status={response.status} />
            </motion.div>
          </AnimatePresence>
        </div>
        <span className="text-sm flex-1">
          <span className="text-muted-foreground mr-1.5">[{response.requestIndex + 1}]</span>
          {response.status === "pending" && (
            <span className="text-muted-foreground italic">waiting…</span>
          )}
          {response.status === "streaming" && (
            <span className="text-blue-600 italic text-xs">streaming…</span>
          )}
          {response.status === "done" && response.vote && (
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${badgeColor}`}>
              {response.vote}
            </span>
          )}
          {response.status === "done" && !response.vote && (
            <span className="text-yellow-700">no answer</span>
          )}
        </span>
        {hasOptionReasons && (
          <span className="text-xs text-muted-foreground ml-1">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </motion.div>

      <AnimatePresence>
        {hasOptionReasons && expanded && (
          <motion.div
            className="mt-1 ml-1.5 border-l border-dashed border-foreground/20 pl-5 overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ul className="py-1 space-y-2">
              {choices.map((choice) => {
                const isChosen = choice === response.vote;
                const reason = response.optionReasons[choice] ?? "";
                const idx = choiceIndex(choice, choices);
                const chipColor = BADGE_COLORS[idx] ?? "bg-muted text-muted-foreground";
                return (
                  <li key={choice} className="flex flex-col gap-0.5">
                    <span
                      className={`self-start rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        isChosen ? chipColor : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {isChosen ? `✓ ${choice}` : `✗ ${choice}`}
                    </span>
                    <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                      {reason || <span className="italic">No reason provided.</span>}
                    </p>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ui/model-response-card.tsx
git commit -m "feat: show per-option reasoning rows in response card"
```

---

### Task 5: Verify in the browser

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

Open `http://localhost:3000`. Submit a dilemma with 2–3 choices.

- [ ] **Step 2: Check model responses**

For each response card, expand a row. Confirm:
- Every option is listed with a labeled chip (`✓ OptionName` or `✗ OptionName`)
- Each chip has a concrete reason below it — not empty, not vague
- The chosen option chip uses the color badge; rejected options are muted

- [ ] **Step 3: Commit (if any fixes needed)**

```bash
git add -p
git commit -m "fix: <describe any fix>"
```
