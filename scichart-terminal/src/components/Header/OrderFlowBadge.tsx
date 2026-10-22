import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";

/** Isolated CVD + delta readout and a v7.4 pipeline diagnostic badge. Subscribes
 *  only to the low-frequency order-flow fields (cvd, forming-candle delta, v74
 *  warm state, key-level/sweep counts) so it re-renders independently of the
 *  12-15fps price feed. CVD = session-anchored cumulative volume delta (oz);
 *  the badge confirms the engine pipeline is warm and how many levels/sweeps the
 *  latest frame carries. */
export const OrderFlowBadge = memo(function OrderFlowBadge() {
  const s = useLiveField(
    (snap) => {
      const d = snap.data;
      const kl = d?.key_levels;
      const klCount = kl
        ? [kl.pdh, kl.pdl, kl.pwh, kl.pwl].filter((v) => v != null).length
        : 0;
      return {
        cvd: d?.cvd ?? null,
        delta: d?.trade_candle?.d ?? null,
        v74Warm: !!d?.v74?.frames,
        klCount,
        sweeps: d?.sweep_events?.length ?? 0,
      };
    },
    (a, b) =>
      a.cvd === b.cvd &&
      a.delta === b.delta &&
      a.v74Warm === b.v74Warm &&
      a.klCount === b.klCount &&
      a.sweeps === b.sweeps,
  );

  const fmt = (v: number) => {
    const sign = v > 0 ? "+" : "";
    const abs = Math.abs(v);
    if (abs >= 1000) return `${sign}${(v / 1000).toFixed(2)}k`;
    return `${sign}${v.toFixed(1)}`;
  };
  const toneCvd =
    s.cvd == null
      ? "text-terminal-text-dim"
      : s.cvd > 0
        ? "text-terminal-bull"
        : s.cvd < 0
          ? "text-terminal-bear"
          : "text-terminal-gold";
  const toneDelta =
    s.delta == null
      ? "text-terminal-text-dim"
      : s.delta > 0
        ? "text-terminal-bull"
        : s.delta < 0
          ? "text-terminal-bear"
          : "text-terminal-gold";

  return (
    <div className="hidden xl:flex items-center gap-2 text-2xs font-mono">
      <div
        className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60"
        title="Session-anchored Cumulative Volume Delta (buy − sell, oz, resets 00:00 UTC)"
      >
        <span className="text-terminal-text-dim">CVD:</span>
        <span className={`font-bold tabular-nums ${toneCvd}`}>
          {s.cvd == null ? "—" : fmt(s.cvd)}
        </span>
      </div>
      <div
        className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60"
        title="Forming trade-candle delta (buy − sell volume, oz)"
      >
        <span className="text-terminal-text-dim">Δ:</span>
        <span className={`font-bold tabular-nums ${toneDelta}`}>
          {s.delta == null ? "—" : fmt(s.delta)}
        </span>
      </div>
      <div
        className={`flex items-center gap-1.5 px-2 py-1 rounded border text-2xs ${
          s.v74Warm
            ? "bg-terminal-bull/10 border-terminal-bull/40 text-terminal-bull"
            : "bg-terminal-panel/80 border-terminal-border/60 text-terminal-text-dim"
        }`}
        title="v7.4 engine pipeline: warm state · key levels in frame · recent liq sweeps"
      >
        <span className="font-bold">{s.v74Warm ? "v74●" : "v74○"}</span>
        <span className="text-terminal-text-dim">KL</span>
        <span className="font-bold tabular-nums">{s.klCount}</span>
        <span className="text-terminal-text-dim">SW</span>
        <span className="font-bold tabular-nums">{s.sweeps}</span>
      </div>
    </div>
  );
});
