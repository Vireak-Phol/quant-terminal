import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveOrderBook } from "../../hooks/useLiveOrderBook";
import { price } from "../../lib/format";
import {
  fmtPF,
  fmtR,
  gateList,
  probabilityView,
  setupLabel,
} from "../../lib/v74";
import type {
  ChartTf,
  LedgerSummaryRow,
  LedgerView,
  RiskConfigV74,
  SideView,
  Tier,
  TimeframeFrame,
  V74Frame,
} from "../../types/v74";

interface Props {
  v74?: V74Frame | null;
  tf: ChartTf;
  onTfChange: (tf: ChartTf) => void;
  onClose?: () => void;
}

type Tab = "signal" | "ledger" | "risk";

export function V7SignalPanel({ v74, tf, onTfChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("signal");
  const fr = v74?.frames?.[tf];

  return (
    <div className="flex flex-col h-full bg-terminal-surface/95 text-terminal-text font-mono text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border/80 bg-terminal-card/60 shrink-0">
        <div className="flex items-center gap-2">
          <StatusDot status={v74?.status} />
          <h2 className="font-bold tracking-wider text-xs">
            v7.4 SIGNAL ENGINE
          </h2>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 bg-terminal-bg/80 border border-terminal-border/80 rounded px-1.5 py-0.5">
            <span className="text-[10px] text-terminal-text-dim uppercase font-semibold">
              Chart TF:
            </span>
            <div className="flex" role="group" aria-label="Signal timeframe">
              {(["5m", "15m"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onTfChange(t)}
                  aria-pressed={tf === t}
                  title={`Switch chart and signal engine to ${t}`}
                  className={`px-1.5 py-0.5 rounded text-2xs font-bold transition-all ${
                    tf === t
                      ? "bg-terminal-gold text-terminal-bg font-extrabold shadow-sm"
                      : "text-terminal-text-dim hover:text-terminal-text"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-terminal-text-dim hover:text-terminal-text px-1 text-sm font-bold"
              aria-label="Close signal panel"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div
        className="flex border-b border-terminal-border/60 shrink-0"
        role="tablist"
      >
        {(["signal", "ledger", "risk"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-2xs font-bold uppercase tracking-wider ${tab === t ? "text-terminal-gold border-b-2 border-terminal-gold" : "text-terminal-text-dim hover:text-terminal-text"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {!v74 ? (
          <Empty
            title="Bridge not connected"
            text="Start the bridge: PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py"
          />
        ) : v74.status === "warming_up" ? (
          <Empty
            title="Warming up engine…"
            text="Replaying 30 days of bars from the active venue so every indicator matches its Pine state."
          />
        ) : v74.status === "error" ? (
          <Empty title="Engine error" text={v74.error ?? "unknown"} />
        ) : tab === "signal" ? (
          <SignalTab fr={fr} tf={tf} />
        ) : tab === "ledger" ? (
          <LedgerTab tf={tf} />
        ) : (
          <RiskTab risk={v74.risk} />
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status?: string }) {
  const cls =
    status === "live"
      ? "bg-terminal-bull animate-pulse"
      : status === "degraded" || status === "warming_up"
        ? "bg-terminal-warn"
        : "bg-terminal-bear";
  return (
    <span
      className={`w-2 h-2 rounded-full ${cls}`}
      aria-label={`engine ${status ?? "offline"}`}
    />
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="p-4 rounded-lg border border-terminal-border/60 bg-terminal-card/40 text-center space-y-1">
      <p className="font-bold text-xs">{title}</p>
      <p className="text-2xs text-terminal-text-dim break-words">{text}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal tab
// ─────────────────────────────────────────────────────────────────────────────
function SignalTab({ fr, tf }: { fr?: TimeframeFrame; tf: ChartTf }) {
  if (!fr || !fr.ready)
    return (
      <Empty
        title="Collecting history"
        text="Engine needs 100 bars before scoring."
      />
    );
  return (
    <>
      <InstitutionalQuantCard fr={fr} tf={tf} />
      <div className="grid grid-cols-2 gap-2">
        <SideCard
          title="LONG"
          side={fr.long!}
          gates={gateList(fr, "long")}
          bull
        />
        <SideCard
          title="SHORT"
          side={fr.short!}
          gates={gateList(fr, "short")}
        />
      </div>
      <ContextCard fr={fr} />
      <p className="text-2xs text-terminal-text-dim leading-relaxed">
        Quant engine fuses GEX regime, Cornish-Fisher VWAP ±2.0σ, Globex session
        anchors, and order book iceberg absorption. Passive maker limit
        execution eliminates taker fee drag.
      </p>
    </>
  );
}

function InstitutionalQuantCard({
  fr,
  tf,
}: {
  fr: TimeframeFrame;
  tf: ChartTf;
}) {
  const { data: liveData } = useLiveOrderBook();
  const sig = fr.active_signal ?? null;
  const ctx = fr.context!;

  // Real-time market state parameters
  const spot =
    liveData?.mid_price && liveData.mid_price > 0
      ? liveData.mid_price
      : (sig?.plan?.entry ?? 0);
  const kl = liveData?.key_levels;
  const vz = liveData?.vwap_z;
  const absorptions = liveData?.absorption_candidates;
  const cvd = liveData?.cvd ?? 0;

  // Memoized institutional quantitative plan calculation to prevent GC churn & unneeded recomputations
  const planState = useMemo(() => {
    // 1. Gamma Exposure (GEX) Regime
    const gexRegime =
      kl?.gex_regime ??
      (kl?.net_gex?.startsWith("-") ? "NEGATIVE_GEX" : "POSITIVE_GEX");
    const isLongGamma =
      gexRegime === "POSITIVE_GEX" || gexRegime === "LONG_GAMMA";

    // 2. Anchored VWAP and Dynamic Standard Deviation Bands (algo.py calculate_anchored_vwap)
    const vwap = vz?.vwap && vz.vwap > 0 ? vz.vwap : spot;
    const atr = ctx.atr && ctx.atr > 1.0 ? ctx.atr : 4.5;
    const structuralUnit = Math.max(atr, 4.0);
    const std =
      vz?.fibUpper2 && vwap > 0 && Math.abs(vz.fibUpper2 - vwap) > 3.0
        ? Math.abs(vz.fibUpper2 - vwap) / 2.0
        : structuralUnit * 1.5;
    const vwapUpper2 =
      vz?.fibUpper2 && vz.fibUpper2 > vwap + 2.0
        ? vz.fibUpper2
        : vwap + 2.0 * std;
    const vwapLower2 =
      vz?.fibLower2 && vz.fibLower2 < vwap - 2.0
        ? vz.fibLower2
        : vwap - 2.0 * std;

    const globexOpen = kl?.globex_open ?? null;
    const gammaFlip = kl?.gamma_flip ?? null;
    const callWall = kl?.call_wall ?? null;
    const putWall = kl?.put_wall ?? null;
    const pdl = kl?.pdl ?? fr.structure?.key_levels?.pdl ?? null;

    // Downside and upside vacuum / Hopla magnets
    const vacBelow =
      fr.structure?.vac_below ?? fr.structure?.hopla?.line_3 ?? null;
    const vacAbove =
      fr.structure?.vac_above ?? fr.structure?.hopla?.line_97 ?? null;
    const hasVacuumBelow =
      vacBelow != null &&
      spot > vacBelow &&
      spot - vacBelow >= 2.0 &&
      spot - vacBelow <= 12.0;
    const hasVacuumAbove =
      vacAbove != null &&
      vacAbove > spot &&
      vacAbove - spot >= 2.0 &&
      vacAbove - spot <= 12.0;

    // Hysteresis deadband for sweeps (requires at least 1.5 pts displacement outside anchor noise)
    const sweepBuffer = Math.max(1.5, structuralUnit * 0.25);
    // Auction Market Theory: Probing above Globex Open and failing back below is a Failed Auction / Open Rejection (Short)
    const isBelowGlobexRejection =
      globexOpen != null && spot <= globexOpen - sweepBuffer;
    // Breakout acceptance above Globex Open
    const isAboveGlobexAcceptance =
      globexOpen != null && spot >= globexOpen + sweepBuffer;

    // VWAP Premium vs Discount: Price above VWAP is in Premium (mean reversion pull is DOWN to VWAP)
    const isVwapPremium = spot >= vwap + 0.3;
    const isVwapDiscount = spot <= vwap - 0.3;
    const vwapDiff = spot - vwap;

    // Dealer Gamma Flip regime: At or below Gamma Flip enters Negative Gamma (-GEX accelerator)
    const isNearGammaFlip =
      gammaFlip != null &&
      Math.abs(spot - gammaFlip) <= Math.max(2.5, structuralUnit * 0.4);
    const isUnderGammaFlip = gammaFlip != null && spot <= gammaFlip + 0.5;
    const isAboveGammaFlip =
      gammaFlip != null && spot >= gammaFlip + sweepBuffer;
    const isNearGlobexOpen =
      globexOpen != null && Math.abs(spot - globexOpen) <= sweepBuffer;

    // 3. Microstructure Iceberg Absorption (algo.py detect_absorption)
    // Proximity gate: only active within 2.5 pts of spot so stale historical bubbles don't trigger false entries.
    //
    // IMPORTANT: bridge emits `a.side` as the AGGRESSOR side (who was trapped), NOT the passive side:
    //   a.side === 'buy'  → aggressive BUYERS were trapped by a passive SELLER  → SHORT confluence (askAbsorption)
    //   a.side === 'sell' → aggressive SELLERS were trapped by a passive BUYER   → LONG confluence (bidAbsorption)
    const askAbsorption =
      (absorptions ?? []).some(
        (a) =>
          (a.side === "buy" ||
            a.reason?.toLowerCase().includes("buyer") ||
            a.reason?.toLowerCase().includes("ask")) &&
          Math.abs(spot - (Number(a.price) || spot)) <=
            Math.max(2.5, structuralUnit * 0.5),
      ) ||
      (sig?.direction === "SHORT" &&
        sig.tags.some((t) => t.includes("absorb") || t.includes("wick")));

    const bidAbsorption =
      (absorptions ?? []).some(
        (a) =>
          (a.side === "sell" ||
            a.reason?.toLowerCase().includes("seller") ||
            a.reason?.toLowerCase().includes("bid")) &&
          Math.abs(spot - (Number(a.price) || spot)) <=
            Math.max(2.5, structuralUnit * 0.5),
      ) ||
      (sig?.direction === "LONG" &&
        sig.tags.some((t) => t.includes("absorb") || t.includes("wick")));

    // 4. Quant Confluence Evaluation (algo.py evaluate_orderflow_execution)
    const shortConfluences: { text: string; pts: number; active: boolean }[] = [
      {
        text: isLongGamma
          ? "Long Gamma Regime (Mean Reversion Mode)"
          : "Short Gamma Regime (Trend Expansion)",
        pts: 20,
        active: isLongGamma,
      },
      {
        text: globexOpen
          ? `Globex Open Rejection / Failed Auction (< ${price(globexOpen)})`
          : "Failed Auction Below Open",
        pts: 25,
        active: isBelowGlobexRejection,
      },
      {
        text: gammaFlip
          ? `At / Below Gamma Flip (${price(gammaFlip)} -GEX Risk)`
          : "Negative Gamma Acceleration",
        pts: 20,
        active: isUnderGammaFlip,
      },
      {
        text: `Price in VWAP Premium (${price(vwap)} Mean Reversion)`,
        pts: 15,
        active: isVwapPremium,
      },
      {
        text: vacBelow
          ? `Downside Vacuum Pocket (~${(spot - vacBelow).toFixed(1)} pts to ${price(vacBelow)})`
          : "Downside Vacuum Pocket",
        pts: 20,
        active: hasVacuumBelow,
      },
      {
        text: callWall
          ? `Dealer Call Wall (${price(callWall)})`
          : "Dealer Resistance Zone",
        pts: 25,
        active:
          callWall != null
            ? Math.abs(spot - callWall) <= Math.max(3.0, std * 0.8) ||
              spot >= callWall
            : false,
      },
      {
        text: "Iceberg Ask Absorption (Trapped Buyers)",
        pts: 30,
        // Do NOT fall back to fr.short?.setup — that bypasses the absorption gate entirely
        // and gifts +30 pts to every bar that has any short setup regardless of microstructure.
        active: askAbsorption,
      },
      {
        text: "Bearish CVD / 4H Trend Agreement",
        pts: 15,
        // Require BOTH conditions: a single-tick CVD dip in a bull trend should not add 15 pts short score.
        active: ctx.htf_bear && cvd < 0,
      },
    ];

    const longConfluences: { text: string; pts: number; active: boolean }[] = [
      {
        text: isLongGamma
          ? "Long Gamma Regime (Mean Reversion Mode)"
          : "Short Gamma Regime (Trend Expansion)",
        pts: 20,
        active: isLongGamma,
      },
      {
        text: `Price in VWAP Discount / <= -2.0σ (${price(vwapLower2)})`,
        pts: 25,
        // Removed the `|| isVwapDiscount` fallback: being 0.31 pts below VWAP is NOT a -2σ discount.
        // Require price to be at or near the actual lower band to earn the full +25 pts.
        active: spot <= vwapLower2 + std * 0.25,
      },
      {
        text: globexOpen
          ? `Globex Open Acceptance (> ${price(globexOpen)})`
          : "Acceptance Above Open",
        pts: 20,
        active: isAboveGlobexAcceptance,
      },
      {
        text: pdl
          ? `Prior Day Low Swept (${price(pdl)})`
          : "Session Low Liquidity Swept",
        pts: 20,
        active: pdl != null ? spot <= pdl + sweepBuffer : false,
      },
      {
        text: gammaFlip
          ? `Reclaimed Above Gamma Flip (${price(gammaFlip)})`
          : "Positive Gamma Support",
        pts: 20,
        active: isAboveGammaFlip,
      },
      {
        text: vacAbove
          ? `Upside Vacuum Magnet (~${(vacAbove - spot).toFixed(1)} pts to ${price(vacAbove)})`
          : "Upside Vacuum Pocket",
        pts: 20,
        active: hasVacuumAbove,
      },
      {
        text: putWall
          ? `Dealer Put Wall (${price(putWall)})`
          : "Dealer Put Support Zone",
        pts: 25,
        active:
          putWall != null
            ? Math.abs(spot - putWall) <= Math.max(3.0, std * 0.8) ||
              spot <= putWall
            : false,
      },
      {
        text: "Iceberg Bid Absorption (Trapped Sellers)",
        pts: 30,
        // Do NOT fall back to fr.long?.setup — same phantom +30 pts issue as askAbsorption.
        active: bidAbsorption,
      },
      {
        text: "Bullish CVD / 4H Trend Agreement",
        pts: 15,
        // Require BOTH: a single-tick positive CVD in a bear trend should not add 15 pts long score.
        active: ctx.htf_bull && cvd > 0,
      },
    ];

    const shortScore = Math.min(
      100,
      shortConfluences
        .filter((c) => c.active)
        .reduce((sum, c) => sum + c.pts, 0),
    );
    const longScore = Math.min(
      100,
      longConfluences
        .filter((c) => c.active)
        .reduce((sum, c) => sum + c.pts, 0),
    );

    // Determine Directional Conviction with Gamma Flip Consolidation Deadband
    const hasActiveSignal = sig != null;
    let isShortBias = false;
    let isLongBias = false;

    if (hasActiveSignal) {
      if (sig.direction === "SHORT") isShortBias = true;
      else if (sig.direction === "LONG") isLongBias = true;
    } else if (isNearGammaFlip || isNearGlobexOpen) {
      // Actively consolidating at Gamma Flip or Globex Open: require decisive score dominance (>=65 & diff >=20)
      if (shortScore >= 65 && shortScore - longScore >= 20) {
        isShortBias = true;
      } else if (longScore >= 65 && longScore - shortScore >= 20) {
        isLongBias = true;
      }
      // Otherwise remains in equilibrium (both false)
    } else {
      // Outside consolidation deadband: require at least 50 score and 10 pt separation
      if (shortScore >= 50 && shortScore - longScore >= 10) {
        isShortBias = true;
      } else if (longScore >= 50 && longScore - shortScore >= 10) {
        isLongBias = true;
      }
    }

    const isEquilibrium = !isShortBias && !isLongBias;

    // Do NOT floor primaryScore when a signal is active — an artificial floor hides live invalidation.
    // If the signal was A+ at issue but price has moved away from all confluences, the score should
    // reflect that, allowing the trader to recognise the setup is stale.
    const primaryScore = isShortBias
      ? shortScore
      : isLongBias
        ? longScore
        : Math.min(48, Math.max(shortScore, longScore));

    const activeTier: Tier = isEquilibrium
      ? "TRAP"
      : primaryScore >= 75
        ? "A_PLUS"
        : primaryScore >= 50
          ? "STRUCTURAL"
          : "TRAP";

    const activeConfluences = (
      isShortBias ? shortConfluences : isLongBias ? longConfluences : []
    ).filter((c) => c.active);

    // Daily Execution Trade Plan (Institutional Swing Parameters)
    const dailyStopDist = Math.max(structuralUnit * 1.5, 5.5);
    const entry = sig?.plan ? sig.plan.entry : spot;

    // Structural Stop: For short, protect above Globex Open / failed auction high
    const shortStop = Number(
      (globexOpen != null &&
      globexOpen > entry &&
      globexOpen <= entry + dailyStopDist * 1.5
        ? Math.max(globexOpen + 0.8, entry + 4.5)
        : entry + dailyStopDist
      ).toFixed(2),
    );

    const stop = sig?.plan
      ? sig.plan.stop
      : isShortBias
        ? shortStop
        : Number((entry - dailyStopDist).toFixed(2));

    // TP1: Target mean reversion to VWAP if entry is in Premium (Short) or Discount (Long)
    const tp1 = sig?.plan
      ? sig.plan.tp1
      : isShortBias
        ? Number(
            (vwap < entry - 0.5 ? vwap : entry - dailyStopDist * 1.5).toFixed(
              2,
            ),
          )
        : Number(
            (vwap > entry + 0.5 ? vwap : entry + dailyStopDist * 1.5).toFixed(
              2,
            ),
          );

    // TP2 Target: Vacuum floor / Hopla 3% if available, otherwise VWAP extreme / Put Wall
    const idealTp2Short =
      vacBelow != null &&
      vacBelow < tp1 &&
      vacBelow >= entry - dailyStopDist * 3.8
        ? vacBelow
        : Math.min(
            tp1 - dailyStopDist * 1.0,
            Math.max(vwapLower2, entry - dailyStopDist * 3.5),
          );

    const idealTp2Long =
      vacAbove != null &&
      vacAbove > tp1 &&
      vacAbove <= entry + dailyStopDist * 3.8
        ? vacAbove
        : Math.max(
            tp1 + dailyStopDist * 1.0,
            Math.min(vwapUpper2, entry + dailyStopDist * 3.5),
          );

    const tp2 = sig?.plan
      ? sig.plan.tp2
      : isShortBias
        ? Number(
            (putWall != null &&
            putWall < tp1 &&
            putWall >= entry - dailyStopDist * 3.8
              ? putWall
              : idealTp2Short
            ).toFixed(2),
          )
        : Number(
            (callWall != null &&
            callWall > tp1 &&
            callWall <= entry + dailyStopDist * 3.8
              ? callWall
              : idealTp2Long
            ).toFixed(2),
          );

    const riskDist = Math.max(1.0, Math.abs(entry - stop));
    const rewardTp1 = Math.abs(tp1 - entry);
    const rewardTp2 = Math.abs(tp2 - entry);
    const rrTp1 = (rewardTp1 / riskDist).toFixed(1);
    const rrTp2 = (rewardTp2 / riskDist).toFixed(1);
    const dailyRiskLabel =
      activeTier === "A_PLUS"
        ? "1.0% ($1.00)"
        : activeTier === "STRUCTURAL"
          ? "0.5% ($0.50)"
          : "0.0% ($0.00)";

    return {
      vwap,
      vwapDiff,
      isVwapPremium,
      isVwapDiscount,
      vacBelow,
      vacAbove,
      globexOpen,
      gammaFlip,
      callWall,
      putWall,
      isShortBias,
      isLongBias,
      isEquilibrium,
      primaryScore,
      activeTier,
      activeConfluences,
      entry,
      stop,
      tp1,
      tp2,
      riskDist,
      rrTp1,
      rrTp2,
      dailyRiskLabel,
    };
  }, [
    spot,
    kl,
    vz,
    absorptions,
    cvd,
    sig,
    ctx,
    fr.short?.setup,
    fr.long?.setup,
    fr.structure,
  ]);

  const {
    vwap,
    vwapDiff,
    isVwapPremium,
    vacBelow,
    globexOpen,
    gammaFlip,
    isShortBias,
    isLongBias,
    primaryScore,
    activeTier,
    activeConfluences,
    entry,
    stop,
    tp1,
    tp2,
    riskDist,
    rrTp1,
    rrTp2,
    dailyRiskLabel,
  } = planState;

  const pv = sig ? probabilityView(sig.probability) : null;

  const borderTone =
    activeTier === "A_PLUS"
      ? isShortBias
        ? "border-terminal-bear/80"
        : "border-terminal-bull/80"
      : activeTier === "STRUCTURAL"
        ? "border-terminal-gold/80"
        : "border-terminal-border/60";

  return (
    <section
      aria-label="Institutional Quant Engine"
      className={`rounded-lg border-2 ${borderTone} bg-terminal-card/80 p-3 space-y-3 relative overflow-hidden shadow-lg`}
    >
      {/* Top Banner: Quant Header */}
      <div className="flex items-start justify-between gap-2 border-b border-terminal-border/60 pb-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`text-sm font-extrabold tracking-wide ${isShortBias ? "text-terminal-bear" : isLongBias ? "text-terminal-bull" : "text-terminal-text-dim"}`}
            >
              {isShortBias
                ? "▼ DAILY SHORT PLAN"
                : isLongBias
                  ? "▲ DAILY LONG PLAN"
                  : "⚖ DAILY EQUILIBRIUM"}
            </span>
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${
                activeTier === "A_PLUS"
                  ? isShortBias
                    ? "bg-terminal-bear/20 text-terminal-bear border border-terminal-bear/40"
                    : "bg-terminal-bull/20 text-terminal-bull border border-terminal-bull/40"
                  : activeTier === "STRUCTURAL"
                    ? "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/40"
                    : "bg-terminal-bg text-terminal-text-dim border border-terminal-border"
              }`}
            >
              {activeTier === "A_PLUS"
                ? "A+ HARMONIZED"
                : activeTier === "STRUCTURAL"
                  ? "STRUCTURAL (S)"
                  : "WAIT / FRICTION"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-1 text-2xs text-terminal-text-dim">
            <span className="text-terminal-text font-medium">
              algo.py Engine
            </span>
            <span>·</span>
            <span className="text-terminal-gold font-bold">Chart {tf}</span>
            <span>·</span>
            <span className="text-cyan-400 font-medium">
              1 Trade/Day Protocol
            </span>
          </div>
        </div>

        {/* Quant Score Badge */}
        <div className="flex items-center gap-2 text-right shrink-0">
          {pv && <ProbBadge pv={pv} />}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-terminal-text-dim">
              Quant Score
            </p>
            <div className="flex items-baseline justify-end gap-0.5">
              <span
                className={`text-xl font-black tabular-nums ${activeTier === "A_PLUS" ? "text-terminal-gold" : activeTier === "STRUCTURAL" ? "text-cyan-400" : "text-terminal-text-dim"}`}
              >
                {primaryScore.toFixed(0)}
              </span>
              <span className="text-2xs text-terminal-text-dim font-medium">
                / 100
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Daily Macro Anchor & Bias Strip */}
      <div className="rounded-md bg-terminal-bg/85 border border-terminal-border/60 p-2.5 space-y-1.5">
        <div className="flex justify-between items-center text-2xs gap-2">
          <span className="text-terminal-text-dim shrink-0">
            Daily VWAP Benchmark:
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-bold text-terminal-gold tabular-nums">
              {price(vwap)}
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded font-semibold ${
                isVwapPremium
                  ? "bg-terminal-bear/15 text-terminal-bear border border-terminal-bear/30"
                  : "bg-terminal-bull/15 text-terminal-bull border border-terminal-bull/30"
              }`}
            >
              {isVwapPremium ? "Premium" : "Discount"} (
              {vwapDiff >= 0 ? "+" : ""}
              {vwapDiff.toFixed(2)})
            </span>
          </div>
        </div>

        {globexOpen != null && (
          <div className="flex justify-between items-center text-2xs gap-2">
            <span className="text-terminal-text-dim shrink-0">
              Globex Open Anchor:
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-bold text-cyan-400 tabular-nums">
                {price(globexOpen)}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded font-semibold ${
                  spot < globexOpen
                    ? "bg-terminal-bear/15 text-terminal-bear border border-terminal-bear/30"
                    : "bg-terminal-bull/15 text-terminal-bull border border-terminal-bull/30"
                }`}
              >
                {spot < globexOpen ? "Failed Auction Below" : "Accepted Above"}
              </span>
            </div>
          </div>
        )}

        {gammaFlip != null && (
          <div className="flex justify-between items-center text-2xs gap-2">
            <span className="text-terminal-text-dim shrink-0">
              Dealer Gamma Flip:
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-semibold text-terminal-gold tabular-nums">
                {price(gammaFlip)}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded font-semibold ${
                  spot <= gammaFlip
                    ? "bg-terminal-bear/15 text-terminal-bear border border-terminal-bear/30"
                    : "bg-terminal-bull/15 text-terminal-bull border border-terminal-bull/30"
                }`}
              >
                {spot <= gammaFlip ? "-GEX Accelerator" : "+GEX Support"}
              </span>
            </div>
          </div>
        )}

        {vacBelow != null && spot > vacBelow && (
          <div className="flex justify-between items-center text-2xs gap-2">
            <span className="text-terminal-text-dim shrink-0">
              Downside Vacuum (Hopla 3%):
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="font-semibold text-purple-400 tabular-nums">
                {price(vacBelow)}
              </span>
              <span className="text-[10px] px-1.5 py-0.2 rounded font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">
                ~{(spot - vacBelow).toFixed(1)} pts magnet
              </span>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center text-2xs gap-2">
          <span className="text-terminal-text-dim shrink-0">
            Institutional Bias:
          </span>
          <span
            className={`font-bold tabular-nums text-right ${
              isShortBias
                ? "text-terminal-bear"
                : isLongBias
                  ? "text-terminal-bull"
                  : "text-terminal-warn"
            }`}
          >
            {isShortBias
              ? "▼ Short Bias (Failed Auction & -GEX Vacuum)"
              : isLongBias
                ? "▲ Long Bias (Discount Accumulation)"
                : "⚖ Neutral (Consolidation Deadband)"}
          </span>
        </div>
      </div>

      {/* Progress Score Bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-terminal-text-dim">
          <span>0 (Friction)</span>
          <span className="text-terminal-border">50 (S)</span>
          <span className="text-terminal-gold font-semibold">
            75 (A+ Floor)
          </span>
          <span>100</span>
        </div>
        <div className="relative h-2 rounded-full bg-terminal-bg border border-terminal-border/60 overflow-hidden">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              activeTier === "A_PLUS"
                ? isShortBias
                  ? "bg-terminal-bear"
                  : "bg-terminal-bull"
                : activeTier === "STRUCTURAL"
                  ? "bg-terminal-gold"
                  : "bg-terminal-text-dim/40"
            }`}
            style={{ width: `${Math.min(100, Math.max(5, primaryScore))}%` }}
          />
          <div className="absolute top-0 bottom-0 left-[75%] w-0.5 bg-terminal-gold/80" />
        </div>
        {pv && <ProbBar pv={pv} />}
      </div>

      {/* Confluence Reason Pills (algo.py evaluate_orderflow_execution) */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-text-dim">
          Active Confluences ({activeConfluences.length} confirmed)
        </p>
        <div className="space-y-1">
          {activeConfluences.length > 0 ? (
            activeConfluences.map((c, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-2xs text-terminal-text"
              >
                <span className="text-terminal-bull font-bold shrink-0">✔</span>
                <span className="truncate">{c.text}</span>
                <span className="ml-auto text-[10px] text-terminal-gold shrink-0">
                  +{c.pts}
                </span>
              </div>
            ))
          ) : (
            <p className="text-2xs text-terminal-text-dim italic">
              Price inside fair value bounds. Waiting for ±2.0σ or GEX Wall
              test.
            </p>
          )}
        </div>
      </div>

      {/* Daily Master Execution Plan (One Good Trade Per Day) */}
      <div className="space-y-1.5 border-t border-terminal-border/60 pt-2">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-gold animate-pulse" />
            <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-gold">
              Daily Master Plan (1 Trade/Day)
            </p>
          </div>
          <span className="text-[10px] font-mono text-terminal-gold bg-terminal-gold/10 px-1 rounded">
            0.00% Maker Fee
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5 text-center">
          <Level label="Daily Entry" value={price(entry)} />
          <Level
            label="Daily Stop"
            value={price(stop)}
            cls="text-terminal-bear"
          />
          <Level
            label="TP1 (d-VWAP)"
            value={price(tp1)}
            cls="text-terminal-bull"
          />
          <Level
            label="TP2 (Extreme)"
            value={price(tp2)}
            cls="text-terminal-bull"
          />
        </div>
        <div className="grid grid-cols-4 gap-1.5 text-center">
          <Level label="Risk/Stop" value={`${riskDist.toFixed(2)} pts`} />
          <Level
            label="R:R TP1"
            value={`1:${rrTp1}`}
            cls="text-terminal-bull"
          />
          <Level
            label="R:R TP2"
            value={`1:${rrTp2}`}
            cls="text-terminal-bull"
          />
          <Level label="Daily Risk" value={dailyRiskLabel} />
        </div>
      </div>

      {sig && sig.factors && sig.factors.length > 0 && (
        <details>
          <summary className="cursor-pointer text-2xs text-terminal-text-dim hover:text-terminal-text">
            Pine & Microstructure Factor Breakdown ({sig.factors.length}{" "}
            factors)
          </summary>
          <div className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto pr-1">
            {sig.factors.slice(0, 8).map((f) => (
              <div key={f.key} className="flex justify-between text-2xs">
                <span className="text-terminal-text-dim">{f.label}</span>
                <span
                  className={`tabular-nums font-semibold ${f.log_odds >= 0 ? "text-terminal-bull" : "text-terminal-bear"}`}
                >
                  {f.log_odds >= 0 ? "▲ +" : "▼ "}
                  {f.log_odds.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ProbBadge({ pv }: { pv: ReturnType<typeof probabilityView> }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wider text-terminal-text-dim">
        {pv.kind === "measured" ? "Measured win rate" : "Win rate"}
      </p>
      <p
        className={`text-base font-extrabold tabular-nums ${pv.kind === "measured" ? "text-terminal-gold" : "text-terminal-text-dim"}`}
      >
        {pv.headline}
      </p>
      <p className="text-[10px] text-terminal-text-dim">{pv.sub}</p>
      {pv.expectancy != null && (
        <p
          className={`text-2xs font-bold ${pv.expectancy > 0 ? "text-terminal-bull" : "text-terminal-bear"}`}
        >
          E {fmtR(pv.expectancy)} net
        </p>
      )}
    </div>
  );
}

function ProbBar({ pv }: { pv: ReturnType<typeof probabilityView> }) {
  if (
    pv.kind !== "measured" ||
    pv.ciLo == null ||
    pv.ciHi == null ||
    pv.value == null
  )
    return null;
  return (
    <div
      className="relative h-2 rounded bg-terminal-bg border border-terminal-border/60"
      role="img"
      aria-label={`Win rate ${pv.value.toFixed(1)} percent, confidence interval ${pv.ciLo.toFixed(0)} to ${pv.ciHi.toFixed(0)} percent`}
    >
      <div
        className="absolute inset-y-0 bg-terminal-gold/30"
        style={{
          left: `${pv.ciLo}%`,
          width: `${Math.max(1, pv.ciHi - pv.ciLo)}%`,
        }}
      />
      <div
        className="absolute inset-y-0 w-0.5 bg-terminal-gold"
        style={{ left: `${pv.value}%` }}
      />
      <div
        className="absolute inset-y-0 w-px bg-terminal-text-dim/60"
        style={{ left: "50%" }}
      />
    </div>
  );
}

function Level({
  label,
  value,
  cls = "",
}: {
  label: string;
  value: string;
  cls?: string;
}) {
  return (
    <div className="rounded bg-terminal-bg/60 border border-terminal-border/40 py-1">
      <p className="text-[10px] uppercase text-terminal-text-dim">{label}</p>
      <p className={`text-2xs font-bold tabular-nums ${cls}`}>{value}</p>
    </div>
  );
}

function SideCard({
  title,
  side,
  gates,
  bull,
}: {
  title: string;
  side: SideView;
  gates: { label: string; pass: boolean }[];
  bull?: boolean;
}) {
  return (
    <div className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2 space-y-1">
      <div className="flex justify-between items-baseline">
        <span
          className={`font-bold text-2xs ${bull ? "text-terminal-bull" : "text-terminal-bear"}`}
        >
          {bull ? "▲" : "▼"} {title}
        </span>
        <span
          className="text-2xs tabular-nums"
          title="OSC model score (heuristic, not a probability)"
        >
          score {side.score.toFixed(0)}
        </span>
      </div>
      <p className="text-2xs text-terminal-text-dim truncate">
        {side.setup ? setupLabel(side.setup) : "no setup this bar"}
      </p>
      <ul className="space-y-0.5">
        {gates.map((g) => (
          <li key={g.label} className="flex justify-between text-[10px]">
            <span className="text-terminal-text-dim">{g.label}</span>
            <span
              className={g.pass ? "text-terminal-bull" : "text-terminal-bear"}
            >
              {g.pass ? "✔" : "✖"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContextCard({ fr }: { fr: TimeframeFrame }) {
  const c = fr.context!;
  const h = fr.structure?.hopla;
  const rows: [string, string, string?][] = [
    ["Regime", `${c.regime} (ER ${c.er.toFixed(2)})`],
    [
      "Session",
      c.killzone.replace("_", " ") + (c.kz_confirmed ? " · vol✔" : ""),
    ],
    [
      "4H trend",
      c.htf_bull ? "▲ above EMA200" : c.htf_bear ? "▼ below EMA200" : "—",
      c.htf_bull
        ? "text-terminal-bull"
        : c.htf_bear
          ? "text-terminal-bear"
          : "",
    ],
    [
      "Shock guard",
      c.shock_hard
        ? "HARD — signals muted"
        : c.shock_soft
          ? "cooldown"
          : "clear",
      c.shock_hard
        ? "text-terminal-bear"
        : c.shock_soft
          ? "text-terminal-warn"
          : "text-terminal-bull",
    ],
    [
      "VWAP Z / SMPI",
      `${c.vwap_z.toFixed(2)} / ${c.smpi == null ? "—" : c.smpi.toFixed(2)}`,
    ],
    ["N_eff / k", `${c.n_eff.toFixed(2)} / ${c.k_active}`],
    ["A+ threshold", `${c.dynamic_min.toFixed(1)}`],
    [
      "ATR / sess σ",
      `${c.atr?.toFixed(2) ?? "—"} / ${c.session_vol?.toFixed(2) ?? "—"}`,
    ],
  ];
  if (h)
    rows.push([
      "Hopla 3 / 97",
      `${price(h.line_3)} / ${price(h.line_97)}`,
      h.in_discount || h.near_3
        ? "text-terminal-bull"
        : h.in_premium || h.near_97
          ? "text-terminal-bear"
          : "",
    ]);
  const s = fr.structure;
  if (s?.vac_above != null || s?.vac_below != null)
    rows.push([
      "Vacuum ↑ / ↓",
      `${price(s?.vac_above)} / ${price(s?.vac_below)}`,
    ]);
  return (
    <section
      aria-label="Market context"
      className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2"
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-text-dim mb-1">
        Market context
      </p>
      <dl className="space-y-0.5">
        {rows.map(([k, v, cls]) => (
          <div key={k} className="flex justify-between text-2xs">
            <dt className="text-terminal-text-dim">{k}</dt>
            <dd className={`tabular-nums ${cls ?? ""}`}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger tab
// ─────────────────────────────────────────────────────────────────────────────
function LedgerTab({ tf }: { tf: ChartTf }) {
  const { socket, sendCommand, connectionState } = useLiveOrderBook();
  const [view, setView] = useState<LedgerView | null>(null);
  const [source, setSource] = useState<"backtest" | "live">("backtest");

  useEffect(
    () =>
      socket.onReply((m) => {
        if (m.type === "ledger") setView(m as unknown as LedgerView);
      }),
    [socket],
  );
  const refresh = useCallback(
    () => sendCommand("get_ledger", { tf, limit: 50 }),
    [sendCommand, tf],
  );
  useEffect(() => {
    if (connectionState !== "connected") return;
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh, connectionState]);

  const rows: LedgerSummaryRow[] = useMemo(
    () =>
      (view?.summary[source] ?? []).filter(
        (r) => r.tier !== "TRAP" || source === "backtest",
      ),
    [view, source],
  );
  if (!view)
    return (
      <Empty
        title="Loading ledger…"
        text="Requesting measured results from the bridge."
      />
    );
  const rel = view.reliability[tf] ?? [];
  return (
    <>
      <div className="flex items-center justify-between">
        <div
          className="flex rounded border border-terminal-border p-0.5"
          role="group"
          aria-label="Ledger source"
        >
          {(["backtest", "live"] as const).map((s) => (
            <button
              key={s}
              aria-pressed={source === s}
              onClick={() => setSource(s)}
              className={`px-2 py-0.5 rounded text-2xs font-bold ${source === s ? "bg-terminal-gold/20 text-terminal-gold" : "text-terminal-text-dim"}`}
            >
              {s} ({view.counts[s]})
            </button>
          ))}
        </div>
        <button
          onClick={refresh}
          className="text-2xs text-terminal-text-dim hover:text-terminal-text"
          aria-label="Refresh ledger"
        >
          ⟳ refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-2xs">
          <caption className="sr-only">
            Measured results per setup and tier, net of costs
          </caption>
          <thead>
            <tr className="text-terminal-text-dim text-left">
              <th className="font-normal py-0.5">Setup</th>
              <th className="font-normal">Tier</th>
              <th className="font-normal text-right">n</th>
              <th className="font-normal text-right">Win%</th>
              <th className="font-normal text-right">E net</th>
              <th className="font-normal text-right">E gross</th>
              <th className="font-normal text-right">PF</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.setup}-${r.tier}`}
                className={`border-t border-terminal-border/30 ${r.warmup ? "text-terminal-text-dim" : ""}`}
              >
                <td className="py-0.5">{setupLabel(r.setup)}</td>
                <td>
                  {r.tier === "A_PLUS"
                    ? "A+"
                    : r.tier === "STRUCTURAL"
                      ? "S"
                      : "T"}
                </td>
                <td className="text-right tabular-nums">{r.n}</td>
                <td
                  className="text-right tabular-nums"
                  title={`95% CI ${r.ci_lo}–${r.ci_hi}%`}
                >
                  {r.warmup ? "warm-up" : `${r.win_rate.toFixed(1)}`}
                </td>
                <td
                  className={`text-right tabular-nums ${r.expectancy_r > 0 ? "text-terminal-bull" : "text-terminal-bear"}`}
                >
                  {fmtR(r.expectancy_r)}
                </td>
                <td
                  className={`text-right tabular-nums ${r.gross_expectancy_r > 0 ? "text-terminal-bull" : "text-terminal-bear"}`}
                >
                  {fmtR(r.gross_expectancy_r)}
                </td>
                <td className="text-right tabular-nums">{fmtPF(r)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td
                  colSpan={7}
                  className="py-2 text-center text-terminal-text-dim"
                >
                  No closed {source} records for {tf} yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {source === "backtest" && rel.length > 0 && (
        <section
          aria-label="Reliability"
          className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2"
        >
          <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-text-dim mb-1">
            Model score vs measured win rate
          </p>
          <div
            className="flex items-end gap-0.5 h-16"
            role="img"
            aria-label="Bar chart of measured win rate per model score bin"
          >
            {rel.map((b) => (
              <div
                key={b.score_bin}
                className="flex-1 flex flex-col items-center justify-end h-full"
                title={`score ${b.score_bin}-${b.score_bin + 5}: ${b.win_rate}% (n=${b.n})`}
              >
                <div
                  className={`w-full ${b.expectancy_r > 0 ? "bg-terminal-bull/70" : "bg-terminal-bear/60"}`}
                  style={{ height: `${Math.min(100, b.win_rate)}%` }}
                />
              </div>
            ))}
          </div>
          <p className="text-[10px] text-terminal-text-dim mt-1">
            A flat profile means the model score does not separate winners from
            losers on this data.
          </p>
        </section>
      )}
      {source === "live" && view.recent.length > 0 && (
        <ul className="space-y-0.5">
          {view.recent.slice(0, 15).map((r) => (
            <li key={r.id} className="flex justify-between text-2xs">
              <span
                className={
                  r.direction === "LONG"
                    ? "text-terminal-bull"
                    : "text-terminal-bear"
                }
              >
                {r.direction === "LONG" ? "▲" : "▼"} {setupLabel(r.setup)}
              </span>
              <span className="text-terminal-text-dim">
                {r.status === "open" ? "open" : `${r.outcome} ${fmtR(r.r_net)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk tab
// ─────────────────────────────────────────────────────────────────────────────
const RISK_FIELDS: {
  key: keyof RiskConfigV74;
  label: string;
  step: number;
  min: number;
  max?: number;
  scale?: number;
  suffix?: string;
}[] = [
  {
    key: "account_equity",
    label: "Account equity",
    step: 10,
    min: 1,
    suffix: "USDT",
  },
  {
    key: "risk_pct",
    label: "Risk per trade",
    step: 0.1,
    min: 0.1,
    max: 10,
    suffix: "%",
  },
  {
    key: "taker_fee_rate",
    label: "Fee per side",
    step: 0.001,
    min: 0,
    max: 0.5,
    scale: 100,
    suffix: "%",
  },
  {
    key: "slippage_ticks",
    label: "Slippage (round trip)",
    step: 1,
    min: 0,
    suffix: "ticks",
  },
  {
    key: "leverage_cap",
    label: "Leverage cap",
    step: 1,
    min: 1,
    max: 125,
    suffix: "×",
  },
  { key: "sl_mult", label: "Stop (× session σ)", step: 0.1, min: 0.5, max: 5 },
  { key: "tp1_mult", label: "TP1 (× session σ)", step: 0.1, min: 0.5, max: 10 },
  { key: "tp2_mult", label: "TP2 (× session σ)", step: 0.1, min: 0.5, max: 15 },
  {
    key: "horizon_bars",
    label: "Ledger horizon",
    step: 1,
    min: 1,
    max: 200,
    suffix: "bars",
  },
  {
    key: "max_trades_per_day",
    label: "Max A+ trades / day",
    step: 1,
    min: 1,
    max: 50,
  },
  {
    key: "daily_loss_limit_r",
    label: "Daily loss warning",
    step: 0.5,
    min: 0.5,
    max: 20,
    suffix: "R",
  },
  {
    key: "max_consecutive_losses",
    label: "Loss streak warning",
    step: 1,
    min: 1,
    max: 20,
  },
];

function RiskTab({ risk }: { risk: RiskConfigV74 }) {
  const { socket, sendCommand } = useLiveOrderBook();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(
    () =>
      socket.onReply((m) => {
        if (m.type === "risk_config")
          setMsg(
            m.ok
              ? "Saved. New signals use these settings."
              : `Rejected: ${String(m.error)}`,
          );
      }),
    [socket],
  );
  const val = (f: (typeof RISK_FIELDS)[number]) =>
    draft[f.key] ??
    String(+((risk[f.key] as number) * (f.scale ?? 1)).toFixed(6));
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const config: Record<string, number> = {};
    for (const f of RISK_FIELDS) {
      if (draft[f.key] === undefined) continue;
      const n = Number(draft[f.key]);
      if (!Number.isFinite(n) || n < f.min || (f.max != null && n > f.max)) {
        setMsg(`${f.label}: must be between ${f.min} and ${f.max ?? "∞"}`);
        return;
      }
      config[f.key] = n / (f.scale ?? 1);
    }
    sendCommand("set_risk_config", { config });
    setDraft({});
  };
  const roundTrip = risk.taker_fee_rate * 2 * 100;
  return (
    <form onSubmit={save} className="space-y-2" aria-label="Risk settings">
      {RISK_FIELDS.map((f) => (
        <label
          key={f.key}
          className="flex items-center justify-between gap-2 text-2xs"
        >
          <span className="text-terminal-text-dim">{f.label}</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step={f.step}
              min={f.min}
              max={f.max}
              value={val(f)}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [f.key]: e.target.value }))
              }
              className="w-20 bg-terminal-bg border border-terminal-border rounded px-1.5 py-0.5 text-right tabular-nums focus:outline-none focus:border-terminal-gold"
            />
            <span className="w-8 text-terminal-text-dim">{f.suffix ?? ""}</span>
          </span>
        </label>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          className="px-3 py-1 rounded bg-terminal-gold/20 border border-terminal-gold/50 text-terminal-gold font-bold text-2xs"
        >
          Save
        </button>
        {Object.keys(draft).length > 0 && (
          <button
            type="button"
            onClick={() => setDraft({})}
            className="text-2xs text-terminal-text-dim"
          >
            Discard
          </button>
        )}
      </div>
      {msg && (
        <p role="status" className="text-2xs text-terminal-text-dim">
          {msg}
        </p>
      )}
      <p className="text-2xs text-terminal-text-dim leading-relaxed">
        Round-trip cost ≈ {roundTrip.toFixed(3)}% of price (≈ $
        {(risk.taker_fee_rate * 2 * 4000).toFixed(2)}/oz at $4,000) plus
        slippage. On short timeframes this can exceed the stop distance; using
        maker (limit) entries roughly halves it.
      </p>
    </form>
  );
}
