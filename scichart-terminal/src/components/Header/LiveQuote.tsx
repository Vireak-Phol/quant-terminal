import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import { price } from "../../lib/format";

/** Isolated, memoised live-quote strip. Subscribes only to mid/spread/imbalance
 *  so it re-renders on price changes without reconciling the whole header. */
export const LiveQuote = memo(function LiveQuote() {
  const q = useLiveField(
    (s) => ({
      mid: s.data?.mid_price ?? 0,
      spread: s.data?.spread ?? 0,
      imbalance: s.data?.imbalance ?? 0,
    }),
    (a, b) =>
      a.mid === b.mid && a.spread === b.spread && a.imbalance === b.imbalance,
  );
  if (!q.mid) return <div className="hidden lg:block" />;
  return (
    <div className="hidden lg:flex items-center gap-3 text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-terminal-panel border border-terminal-border">
        <span className="text-[10px] text-terminal-text-dim">MID</span>
        <span className="font-bold tabular-nums text-sm text-terminal-text">
          {price(q.mid)}
        </span>
      </div>
      <div className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs">
        <span className="text-terminal-text-dim">SPREAD:</span>
        <span className="text-terminal-gold font-bold tabular-nums">
          ${q.spread.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs">
        <span className="text-terminal-text-dim">FLOW:</span>
        <span
          className={`font-bold uppercase ${
            q.imbalance > 0.15
              ? "text-terminal-bull"
              : q.imbalance < -0.15
                ? "text-terminal-bear"
                : "text-terminal-gold"
          }`}
        >
          {q.imbalance > 0
            ? `+${(q.imbalance * 100).toFixed(0)}% BULL`
            : q.imbalance < 0
              ? `${(q.imbalance * 100).toFixed(0)}% BEAR`
              : "BALANCED"}
        </span>
      </div>
    </div>
  );
});
