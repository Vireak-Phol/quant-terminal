import { memo, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/** Active-state colour per button. Full class strings (not interpolated) so the
 *  Tailwind JIT sees them, and all built on theme tokens so dark / contrast /
 *  light themes stay legible. */
export type Tone = "accent" | "gold" | "bull" | "bear" | "info" | "warn";

const TONE_ACTIVE: Record<Tone, string> = {
  accent: "bg-terminal-accent/15 text-terminal-accent ring-terminal-accent/40",
  gold: "bg-terminal-gold/15 text-terminal-gold ring-terminal-gold/40",
  bull: "bg-terminal-bull/15 text-terminal-bull ring-terminal-bull/40",
  bear: "bg-terminal-bear/15 text-terminal-bear ring-terminal-bear/40",
  info: "bg-terminal-info/15 text-terminal-info ring-terminal-info/40",
  warn: "bg-terminal-warn/15 text-terminal-warn ring-terminal-warn/40",
};

const BASE =
  "inline-flex items-center justify-center gap-1.5 h-7 rounded-md text-2xs font-semibold " +
  "tracking-wide whitespace-nowrap select-none transition-colors duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-accent/70 " +
  "disabled:opacity-35 disabled:cursor-not-allowed";

const INACTIVE =
  "text-terminal-text-dim hover:text-terminal-text hover:bg-terminal-text/5";

export interface ToolbarButtonProps {
  icon?: IconName;
  label?: string;
  /** Toggle buttons: pressed state + colour. Omit for plain action buttons. */
  active?: boolean;
  tone?: Tone;
  /** Hide the text label below 2000px (icon-only, tooltip keeps it). */
  collapseLabel?: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

export const ToolbarButton = memo(function ToolbarButton({
  icon,
  label,
  active,
  tone = "accent",
  collapseLabel = false,
  title,
  onClick,
  disabled,
  className = "",
  children,
}: ToolbarButtonProps) {
  const isToggle = active !== undefined;
  const state = active ? `ring-1 ring-inset ${TONE_ACTIVE[tone]}` : INACTIVE;
  const pad = label && !collapseLabel ? "px-2.5" : collapseLabel ? "px-2 min-[2000px]:px-2.5" : "px-2";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label ? undefined : title}
      aria-pressed={isToggle ? active : undefined}
      className={`${BASE} ${pad} ${state} ${className}`}
    >
      {icon && <Icon name={icon} />}
      {label && (
        <span className={collapseLabel ? "hidden min-[2000px]:inline" : undefined}>{label}</span>
      )}
      {children}
    </button>
  );
});

/** Segmented container that visually groups related toolbar buttons. */
export function ToolbarGroup({
  children,
  label,
  className = "",
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex items-center gap-0.5 p-0.5 rounded-lg bg-terminal-panel border border-terminal-border shrink-0 ${className}`}
    >
      {children}
    </div>
  );
}

export function ToolbarDivider({ className = "" }: { className?: string }) {
  return <div className={`h-5 w-px bg-terminal-border shrink-0 ${className}`} aria-hidden="true" />;
}
