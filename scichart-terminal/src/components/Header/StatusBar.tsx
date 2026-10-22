import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import type { Timeframe } from "../../chart/TerminalChart";

/** Isolated, memoised footer. Subscribes only to telemetry counters. */
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
    <footer className="h-6 px-3 border-t border-terminal-border/70 bg-terminal-surface/95 flex items-center justify-between text-[11px] font-mono text-terminal-text-dim shrink-0 z-30">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-terminal-bull font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-bull animate-pulse" />
          SCICHART GPU ENGINE
        </span>
        <span className="hidden sm:inline">
          Binance USDⓈ-M Futures (XAUUSDT)
        </span>
        <span className="hidden md:inline">
          • SYNC:{" "}
          <span className="text-terminal-gold font-bold uppercase">
            {t.sync}
          </span>
        </span>
      </div>
      <div className="hidden lg:flex items-center gap-3 text-2xs">
        <span>{timeframe} Candles</span>
        <span>• Liquidity Heatmap</span>
        <span>• Absorption Bubbles</span>
        <span>• Vacuum / Hopla</span>
      </div>
      <div className="flex items-center gap-3">
        <span>Events: {t.events}</span>
        <span className="hidden sm:inline">• SciChart.js v6 (WASM/WebGL2)</span>
      </div>
    </footer>
  );
});
