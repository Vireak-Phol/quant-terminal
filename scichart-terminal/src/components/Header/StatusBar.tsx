import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import { useVenue } from "../../hooks/useVenue";
import type { Timeframe } from "../../chart/TerminalChart";

/** Isolated, memoised footer. Subscribes only to telemetry counters.
 *  Single-line by construction: every segment is nowrap and lower-priority
 *  segments hide progressively instead of wrapping onto a second line. */
export const StatusBar = memo(function StatusBar({
  timeframe,
}: {
  timeframe: Timeframe;
}) {
  const venue = useVenue();
  const t = useLiveField(
    (s) => ({
      sync: s.data?.telemetry?.order_book_sync_state ?? "—",
      // Batch updates to every 50 events so React is not forced to reconcile 15x/sec
      events: Math.floor((s.data?.telemetry?.total_updates_processed ?? 0) / 50) * 50,
      globex: s.data?.key_levels?.globex_open,
      netGex: s.data?.key_levels?.net_gex,
      gexRegime: s.data?.key_levels?.gex_regime,
      callWall: s.data?.key_levels?.call_wall,
      putWall: s.data?.key_levels?.put_wall,
    }),
    (a, b) =>
      a.sync === b.sync &&
      a.events === b.events &&
      a.globex === b.globex &&
      a.netGex === b.netGex,
  );
  return (
    <footer className="h-6 px-3 border-t border-terminal-border/70 bg-terminal-surface/95 flex items-center justify-between gap-4 text-2xs font-mono text-terminal-text-dim whitespace-nowrap overflow-hidden shrink-0 z-30">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1.5 text-terminal-bull font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-bull" />
          SciChart GPU
        </span>
        <span className="hidden md:inline">{venue.label} · {venue.display_symbol}</span>
        <span title={venue.capabilities.l2_depth ? "L2 order-book sync state" : "Quote stream (no market depth on this venue)"}>
          {venue.capabilities.l2_depth ? "Sync" : "Quotes"}{" "}
          <span className="text-terminal-gold font-semibold uppercase">{t.sync}</span>
        </span>
      </div>
      <div className="hidden xl:flex items-center gap-3">
        <span>{timeframe} candles</span>
        {t.globex ? (
          <span className="text-cyan-400">
            Globex: <strong className="font-semibold">${t.globex.toFixed(2)}</strong>
          </span>
        ) : null}
        {t.netGex ? (
          <span
            className={t.gexRegime === "POSITIVE_GEX" ? "text-emerald-400" : "text-rose-400"}
            title={`Call Wall: $${t.callWall?.toFixed(2) ?? "—"} | Put Wall: $${t.putWall?.toFixed(2) ?? "—"}`}
          >
            GEX: <strong className="font-semibold">{t.netGex}</strong> ({t.gexRegime === "POSITIVE_GEX" ? "+GEX Pin" : "-GEX Vol"})
          </span>
        ) : null}
        <span>· GEX Walls</span>
        <span>· Heatmap</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="tabular-nums">Events {t.events.toLocaleString()}</span>
        <span className="hidden lg:inline">· SciChart.js v6 (WebGL2)</span>
      </div>
    </footer>
  );
});
