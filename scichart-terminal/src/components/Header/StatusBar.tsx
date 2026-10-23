import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import type { Timeframe } from "../../chart/TerminalChart";

/** Isolated, memoised footer. Subscribes only to telemetry counters.
 *  Single-line by construction: every segment is nowrap and lower-priority
 *  segments hide progressively instead of wrapping onto a second line. */
export const StatusBar = memo(function StatusBar({
  timeframe,
}: {
  timeframe: Timeframe;
}) {
  const t = useLiveField(
    (s) => ({
      sync: s.data?.telemetry?.order_book_sync_state ?? "—",
      events: s.data?.telemetry?.total_updates_processed ?? 0,
    }),
    (a, b) => a.sync === b.sync && a.events === b.events,
  );
  return (
    <footer className="h-6 px-3 border-t border-terminal-border/70 bg-terminal-surface/95 flex items-center justify-between gap-4 text-2xs font-mono text-terminal-text-dim whitespace-nowrap overflow-hidden shrink-0 z-30">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1.5 text-terminal-bull font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-bull" />
          SciChart GPU
        </span>
        <span className="hidden md:inline">Binance USDⓈ-M · XAUUSDT</span>
        <span>
          Sync <span className="text-terminal-gold font-semibold uppercase">{t.sync}</span>
        </span>
      </div>
      <div className="hidden xl:flex items-center gap-3">
        <span>{timeframe} candles</span>
        <span>· Heatmap</span>
        <span>· Absorption</span>
        <span>· Vacuum / Hopla</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="tabular-nums">Events {t.events.toLocaleString()}</span>
        <span className="hidden lg:inline">· SciChart.js v6 (WebGL2)</span>
      </div>
    </footer>
  );
});
