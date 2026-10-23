import type { ReactNode } from "react";

/** One label/value cell in the header ticker strip. */
export function Stat({
  label,
  children,
  title,
  className = "",
}: {
  label: string;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex items-baseline gap-1.5 px-2.5 whitespace-nowrap ${className}`}
      title={title}
    >
      <span className="text-2xs uppercase tracking-wider text-terminal-text-dim">{label}</span>
      <span className="font-semibold tabular-nums">{children}</span>
    </div>
  );
}

/** Rounded container with hairline dividers between cells. */
export function StatStrip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-center h-8 rounded-lg bg-terminal-panel/70 border border-terminal-border divide-x divide-terminal-border shrink-0 ${className}`}
    >
      {children}
    </div>
  );
}
