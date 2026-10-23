import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import { price } from "../../lib/format";
import { Stat, StatStrip } from "./Stat";

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
  if (!q.mid) return null;

  const pct = Math.round(q.imbalance * 100);
  const flowTone =
    q.imbalance > 0.15
      ? "text-terminal-bull"
      : q.imbalance < -0.15
        ? "text-terminal-bear"
        : "text-terminal-text";

  return (
    <StatStrip className="hidden lg:flex">
      <Stat label="Mid" title="Mid price">
        <span className="text-[13px] text-terminal-text">{price(q.mid)}</span>
      </Stat>
      <Stat label="Spr" title="Bid/ask spread (USD)">
        <span className="text-terminal-text">{q.spread.toFixed(2)}</span>
      </Stat>
      <Stat label="Book" title="Top-of-book imbalance (bid vs ask resting size)" className="hidden min-[1600px]:flex">
        <span className={flowTone}>
          {pct > 0 ? `+${pct}%` : `${pct}%`}
        </span>
      </Stat>
    </StatStrip>
  );
});
