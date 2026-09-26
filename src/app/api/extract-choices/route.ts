import { complete, DEFAULT_BUCKET } from "@/lib/flexrouter";

export const dynamic = "force-dynamic";

const MIN_CHOICES = 2;
const MAX_CHOICES = 6;

const SYSTEM_PROMPT = `You read a moral dilemma and identify the distinct options the person answering must choose between.

Rules:
- If it is a yes/no question, the options are YES and NO.
- Otherwise give each option a short label of 1-3 words, in UPPERCASE.
- Give between ${MIN_CHOICES} and ${MAX_CHOICES} options, mutually exclusive, no duplicates.

You MUST reply with exactly one line and nothing else:
CHOICES: <option> | <option> | ...`;

function parseChoices(text: string): string[] {
  const match = text.match(/CHOICES:[ \t]*(.+)/i);
  if (!match) return [];
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const raw of match[1].split("|")) {
    const choice = raw.trim().replace(/^["'`*[\]]+|["'`*[\].]+$/g, "").trim().toUpperCase();
    if (choice && !seen.has(choice)) {
      seen.add(choice);
      choices.push(choice);
    }
  }
  return choices;
}

export async function POST(req: Request) {
  const { question } = (await req.json()) as { question?: string };
  if (!question?.trim()) {
    return Response.json({ error: "Question is empty" }, { status: 400 });
  }

  let text: string;
  try {
    // A bucket, not a pinned model: which model does this doesn't matter,
    // and a bucket lets flexrouter fail over on its own.
    text = await complete(
      DEFAULT_BUCKET,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
      { temperature: 0 }
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }

  const choices = parseChoices(text);
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
    return Response.json({ error: "Couldn't work out the options in this dilemma" }, { status: 422 });
  }
  return Response.json({ choices });
}
