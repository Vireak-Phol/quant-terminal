import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import { Stat, StatStrip } from "./Stat";

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
          : "text-terminal-text";
  const toneDelta =
    s.delta == null
      ? "text-terminal-text-dim"
      : s.delta > 0
        ? "text-terminal-bull"
        : s.delta < 0
          ? "text-terminal-bear"
          : "text-terminal-text";

  return (
    <StatStrip className="hidden min-[1440px]:flex">
      <Stat label="CVD" title="Session-anchored cumulative volume delta (buy − sell, oz; resets 00:00 UTC)">
        <span className={toneCvd}>{s.cvd == null ? "—" : fmt(s.cvd)}</span>
      </Stat>
      <Stat label="Δ" title="Forming 1-minute trade-candle delta (buy − sell, oz)">
        <span className={toneDelta}>{s.delta == null ? "—" : fmt(s.delta)}</span>
      </Stat>
      <Stat
        label="v7.4"
        title="Engine pipeline: warm state · key levels in frame · recent liquidity sweeps"
        className="hidden min-[1700px]:flex"
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${s.v74Warm ? "bg-terminal-bull" : "bg-terminal-muted"}`}
            aria-label={s.v74Warm ? "warm" : "warming up"}
          />
          <span className="text-terminal-text-dim font-normal">KL</span>
          <span className="text-terminal-text">{s.klCount}</span>
          <span className="text-terminal-text-dim font-normal">SW</span>
          <span className="text-terminal-text">{s.sweeps}</span>
        </span>
      </Stat>
    </StatStrip>
  );
});
