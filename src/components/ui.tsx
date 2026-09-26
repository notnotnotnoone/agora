"use client";

import { useEffect, type ReactNode } from "react";

export function Box({
  title,
  sub,
  action,
  flush,
  className,
  children,
}: {
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["box", flush && "flush", className].filter(Boolean).join(" ")}>
      <header className="box-head">
        <h2>{title}</h2>
        {sub && <span className="box-sub">{sub}</span>}
        {action && <div className="box-action">{action}</div>}
      </header>
      <div className="box-body">{children}</div>
    </section>
  );
}

export type Tone = "ok" | "warn" | "bad" | "blue" | "violet";

export function Tag({ tone, children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={tone ? `tag ${tone}` : "tag"} title={title}>
      {children}
    </span>
  );
}

/** A choice's colour: flexrouter's chart series, in order. */
export function choiceColor(choices: string[], choice: string | null): string {
  const i = choice ? choices.indexOf(choice) : -1;
  return i === -1 ? "var(--ink-4)" : `var(--s${(i % 6) + 1})`;
}

export function ChoiceTag({ choices, choice }: { choices: string[]; choice: string }) {
  const color = choiceColor(choices, choice);
  return (
    <span className="tag" style={{ color, borderColor: color }}>
      {choice}
    </span>
  );
}

/** flexrouter's side panel. Closes on Escape or a click outside. */
export function Sheet({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button className="sheet-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <div>
            <h2>{title}</h2>
            {sub && <p className="sheet-sub">{sub}</p>}
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </aside>
    </>
  );
}
