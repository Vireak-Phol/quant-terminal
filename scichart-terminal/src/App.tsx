import { memo, useCallback, useEffect, useRef, useState } from "react";
import { usePrefs } from "./store/usePrefs";
import { getSharedSocket, DEFAULT_BRIDGE_URL } from "./hooks/useLiveOrderBook";
import { useLiveField } from "./hooks/useLiveField";
import {
  TerminalChart,
  type Timeframe,
  type ChartLayer,
  type ChartFrame,
} from "./chart/TerminalChart";
import { configureSciChart } from "./chart/scichart-init";
import { fetchBinanceFuturesKlines } from "./lib/klines";
import { price } from "./lib/format";
import { newAplusSignals, playChime } from "./lib/alerts";
import { probabilityView, setupLabel } from "./lib/v74";
import type { ChartTf } from "./types/v74";
import { V7SignalPanel } from "./components/Dashboard/V7SignalPanel";
import { OrderBookLadder } from "./components/Dashboard/OrderBookLadder";
import { DiagnosticsPanel } from "./components/Dashboard/DiagnosticsPanel";
import {
  AbsorptionModal,
  type AbsorptionModalData,
} from "./components/Dashboard/AbsorptionModal";
import { ToastContainer, type ToastMessage } from "./components/Shared/Toast";
import { ErrorBoundary } from "./components/Shared/ErrorBoundary";

configureSciChart();

const CHART_DIV_ID = "scichart-root";
const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m"];

// How many historical klines to seed the chart with on mount / timeframe switch.
// Binance USDⓈ-M /fapi/v1/klines allows up to 1500 in a single request, and the
// chart retains up to MAX_CANDLES (see TerminalChart.ts) — keep this <= that cap.
const HISTORY_LIMIT = 1000;

const LAYER_META: { key: ChartLayer; label: string; glyph: string; on: string }[] = [
  { key: "heatmap", label: "HEATMAP", glyph: "🔥", on: "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-glow" },
  { key: "bubbles", label: "ABSORPTION", glyph: "🫧", on: "bg-terminal-bull/20 text-terminal-bull border border-terminal-bull/40 shadow-glow" },
  { key: "vacuum", label: "VACUUM", glyph: "🧲", on: "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-glow" },
  { key: "hopla", label: "HOPLA", glyph: "📐", on: "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow" },
];

// Memoised panels: only re-render when their own props / subscriptions change,
// never because the parent App re-rendered.
const SignalPanelMemo = memo(V7SignalPanel);
const LadderPanel = memo(OrderBookLadder);
const DiagsPanel = memo(DiagnosticsPanel);

export default function App() {
  const { prefs, cycleTheme } = usePrefs();

  // App only subscribes to low-frequency status fields; the per-frame price feed
  // is handled imperatively below (refs + rAF) so the whole tree does not
  // reconcile 12-15×/sec.
  const { connectionState, latencyMs } = useLiveField(
    (s) => ({ connectionState: s.connectionState, latencyMs: s.latencyMs }),
    (a, b) => a.connectionState === b.connectionState && a.latencyMs === b.latencyMs,
  );

  const chartRef = useRef<TerminalChart | null>(null);
  const readyRef = useRef(false);

  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const timeframeRef = useRef<Timeframe>("1m");
  const [isLoadingKlines, setIsLoadingKlines] = useState(false);

  const [layers, setLayers] = useState<Record<ChartLayer, boolean>>({
    heatmap: true,
    bubbles: true,
    vacuum: true,
    hopla: true,
  });

  const [showSignals, setShowSignals] = useState(true);
  const [showDomLadder, setShowDomLadder] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [signalTf, setSignalTf] = useState<ChartTf>("5m");

  const [soundOn, setSoundOn] = useState<boolean>(
    () => localStorage.getItem("terminal.alertSound") !== "off",
  );
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    soundOnRef.current = soundOn;
    localStorage.setItem("terminal.alertSound", soundOn ? "on" : "off");
  }, [soundOn]);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [absorptionModal, setAbsorptionModal] = useState<AbsorptionModalData | null>(null);

  const seenSignalIds = useRef<Set<string>>(new Set());
  const firstV74Ref = useRef<boolean>(true);

  const addToast = useCallback(
    (message: string, type: ToastMessage["type"] = "info") => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-4), { id, message, type }]);
    },
    [],
  );
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Chart lifecycle (StrictMode-safe) ────────────────────────────────────
  // The cleanup awaits the in-flight async init so the surface created by a
  // double-invoked effect is always torn down — no orphaned WebGL context.
  useEffect(() => {
    let disposed = false;
    const chart = new TerminalChart({ tickSize: 0.5, timeframe: timeframeRef.current });
    const initPromise = chart
      .init(CHART_DIV_ID)
      .then(async () => {
        if (disposed) return;
        chartRef.current = chart;
        readyRef.current = true;
        for (const { key } of LAYER_META) chart.setLayerVisibility(key, layersRef.current[key]);

        setIsLoadingKlines(true);
        try {
          const klines = await fetchBinanceFuturesKlines("XAUUSDT", timeframeRef.current, HISTORY_LIMIT);
          if (!disposed && chartRef.current === chart && klines.length > 0) {
            chart.loadHistoricalCandles(klines);
          }
        } finally {
          if (!disposed) setIsLoadingKlines(false);
        }
      })
      .catch((e) => console.error("SciChart init failed:", e));

    return () => {
      disposed = true;
      readyRef.current = false;
      if (chartRef.current === chart) chartRef.current = null;
      // Ensure delete() runs only after create() has settled, so we never leak
      // the surface of a double-invoked StrictMode mount.
      initPromise.finally(() => chart.delete());
    };
    // Mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a ref of layer state for the init effect (it must not re-run on toggle).
  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // ── Per-frame pipeline: subscribe imperatively, coalesce with rAF ─────────
  // The websocket emits ~12-15 fps; we keep only the newest frame and drain it
  // to the GPU once per animation frame. Intermediate frames are dropped. This
  // decouples chart + alert work from the raw socket rate and caps it at the
  // display refresh, which is the single biggest protection against the tab
  // becoming unresponsive during volatility / replay bursts.
  useEffect(() => {
    const socket = getSharedSocket(DEFAULT_BRIDGE_URL);
    let rafId = 0;
    let pending = false;

    const drain = () => {
      rafId = 0;
      pending = false;
      const snap = socket.getSnapshot();
      const frame = snap.data as ChartFrame | null;
      if (!frame) return;

      if (readyRef.current && chartRef.current) {
        chartRef.current.update(frame);
      }

      // A+ signal alerts (v74 changes only on closed bars, so this is cheap).
      const v74 = (snap.data as { v74?: Parameters<typeof newAplusSignals>[0] } | null)?.v74;
      if (v74) {
        const fresh = newAplusSignals(v74, seenSignalIds.current, firstV74Ref.current);
        firstV74Ref.current = false;
        // Bound the dedup set so it cannot grow unbounded over a long session.
        if (seenSignalIds.current.size > 4000) seenSignalIds.current.clear();
        for (const sig of fresh) {
          const pv = probabilityView(sig.probability);
          const prob =
            pv.kind === "measured"
              ? `win ${pv.headline} (n=${pv.n}, E ${pv.expectancy! >= 0 ? "+" : ""}${pv.expectancy!.toFixed(2)}R)`
              : "win rate warm-up";
          addToast(
            `A+ ${sig.direction} ${sig.tf} · ${setupLabel(sig.setup)} · entry ${price(sig.plan.entry)} SL ${price(sig.plan.stop)} TP1 ${price(sig.plan.tp1)} · ${prob}`,
            sig.direction === "LONG" ? "bull" : "bear",
          );
          if (soundOnRef.current) playChime(sig.direction);
        }
      }
    };

    const schedule = () => {
      if (pending) return;
      pending = true;
      rafId = requestAnimationFrame(drain);
    };

    const unsubscribe = socket.subscribe(schedule);
    // Draw the current snapshot immediately on mount.
    schedule();

    return () => {
      unsubscribe();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [addToast]);

  // ── Timeframe switching ──────────────────────────────────────────────────
  const changeTimeframe = useCallback(
    async (tf: Timeframe) => {
      if (tf === timeframeRef.current) return;
      timeframeRef.current = tf;
      setTimeframe(tf);
      chartRef.current?.setTimeframe(tf);
      setIsLoadingKlines(true);
      try {
        const klines = await fetchBinanceFuturesKlines("XAUUSDT", tf, HISTORY_LIMIT);
        if (chartRef.current && timeframeRef.current === tf && klines.length > 0) {
          chartRef.current.loadHistoricalCandles(klines);
        }
      } finally {
        setIsLoadingKlines(false);
      }
    },
    [],
  );

  // ── Layer toggles ────────────────────────────────────────────────────────
  const toggleLayer = useCallback((key: ChartLayer) => {
    setLayers((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      chartRef.current?.setLayerVisibility(key, next[key]);
      return next;
    });
  }, []);

  // ── Click-to-inspect absorption bubbles ──────────────────────────────────
  const onChartClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const hit = chartRef.current?.hitTestBubble(e.clientX, e.clientY, 18);
    if (hit) {
      setAbsorptionModal({
        time: hit.point?.time ?? hit.x,
        anchorPrice: hit.point?.price ?? hit.y,
        point: hit.point,
      });
    }
  }, []);

  // ── Keyboard: Alt+D toggles DOM ladder ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setShowDomLadder((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-terminal-bg text-terminal-text overflow-hidden font-sans select-none">
      {/* ── Top cockpit header ── */}
      <header className="h-12 flex items-center justify-between px-3 border-b border-terminal-border bg-terminal-surface/95 backdrop-blur-md shrink-0 font-mono text-xs z-30">
        {/* Left: identity + timeframe pills + loading */}
        <div className="flex items-center gap-2 sm:gap-2.5">
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-terminal-panel border border-terminal-border shadow-xs">
            <div className="w-2 h-2 rounded-full bg-terminal-gold shadow-glow animate-pulse" />
            <span className="font-extrabold tracking-wider text-sm text-terminal-text">XAUUSDT</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-terminal-surface border border-terminal-border text-terminal-gold font-bold">
              GPU · USDⓈ-M
            </span>
          </div>

          <div className="h-4 w-px bg-terminal-border/80 mx-0.5" />

          <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => changeTimeframe(tf)}
                className={`px-2 py-0.5 rounded font-bold transition-all text-2xs ${
                  tf === timeframe
                    ? "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow"
                    : "text-terminal-text-dim hover:text-terminal-text hover:bg-terminal-surface"
                }`}
              >
                {tf}
              </button>
            ))}
            <button
              onClick={() => chartRef.current?.resetView()}
              title="Snap back to live edge"
              className="px-2 py-0.5 rounded font-bold text-2xs text-terminal-text-dim hover:text-terminal-text hover:bg-terminal-surface"
            >
              ⟳ LIVE
            </button>
          </div>

          {isLoadingKlines && (
            <span className="text-2xs text-terminal-info flex items-center gap-1">
              <span className="animate-pulse">●</span> loading
            </span>
          )}
        </div>

        {/* Center: live quote (isolated subscriber, re-renders only on price change) */}
        <LiveQuote />

        {/* Center-right: CVD + delta readout and v7.4 pipeline diagnostic badge */}
        <OrderFlowBadge />

        {/* Right: layer + panel toggles, sound, status, theme */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <div className="hidden md:flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5 text-2xs">
            {LAYER_META.map((l) => (
              <button
                key={l.key}
                onClick={() => toggleLayer(l.key)}
                aria-pressed={layers[l.key]}
                className={`px-2 py-0.5 rounded font-bold transition-all ${
                  layers[l.key] ? l.on : "text-terminal-text-dim hover:text-terminal-text"
                }`}
                title={`Toggle ${l.label} layer`}
              >
                {l.glyph} {l.label}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-terminal-border/80 mx-0.5 hidden md:block" />

          <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5 text-2xs">
            <button
              onClick={() => setShowSignals((v) => !v)}
              aria-pressed={showSignals}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showSignals
                  ? "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle v7.4 Institutional Signals Panel"
            >
              ★ SIGNALS
            </button>
            <button
              onClick={() => setShowDomLadder((v) => !v)}
              aria-pressed={showDomLadder}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showDomLadder
                  ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle L2 Order Book DOM Ladder (Alt+D)"
            >
              📊 DOM
            </button>
            <button
              onClick={() => setShowDiagnostics((v) => !v)}
              aria-pressed={showDiagnostics}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showDiagnostics
                  ? "bg-purple-500/25 text-purple-300 border border-purple-500/50 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle Diagnostics & Telemetry Panel"
            >
              🩺 DIAGS
            </button>
            <button
              onClick={() => setSoundOn((v) => !v)}
              aria-pressed={soundOn}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                soundOn ? "text-terminal-gold" : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title={soundOn ? "Mute A+ alert sound" : "Unmute A+ alert sound"}
              aria-label={soundOn ? "Mute alert sound" : "Unmute alert sound"}
            >
              {soundOn ? "🔔" : "🔕"}
            </button>
          </div>

          <div className="h-4 w-px bg-terminal-border/80 mx-0.5" />

          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-semibold bg-terminal-panel border border-terminal-border">
            <span
              className={`w-2 h-2 rounded-full ${
                connectionState === "connected"
                  ? "bg-terminal-bull animate-pulse"
                  : connectionState === "connecting"
                    ? "bg-terminal-gold animate-bounce"
                    : "bg-terminal-bear"
              }`}
            />
            <span className="text-terminal-text-dim uppercase hidden sm:inline">
              {connectionState === "connected" ? `${latencyMs}ms` : "OFFLINE"}
            </span>
          </div>

          <button
            onClick={cycleTheme}
            className="px-2 py-1 text-2xs font-medium text-terminal-text-dim hover:text-terminal-text bg-terminal-panel hover:bg-terminal-surface border border-terminal-border rounded transition-all"
            title={`Current theme: ${prefs.theme}`}
          >
            <span className="text-terminal-accent uppercase font-bold">{prefs.theme}</span>
          </button>
        </div>
      </header>

      {/* ── Workspace: chart + right docks ── */}
      <main className="flex-1 w-full min-h-0 relative flex overflow-hidden bg-terminal-bg">
        <ErrorBoundary title="Chart Workspace">
          <div className="flex-1 h-full min-h-0 relative overflow-hidden">
            <div id={CHART_DIV_ID} onClick={onChartClick} className="absolute inset-0" />
          </div>

          {showSignals && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="Signal Panel">
                <SignalDock
                  tf={signalTf}
                  onTfChange={setSignalTf}
                  onClose={() => setShowSignals(false)}
                />
              </ErrorBoundary>
            </aside>
          )}

          {showDomLadder && (
            <aside className="w-72 lg:w-80 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="DOM Ladder">
                <LadderPanel onClose={() => setShowDomLadder(false)} compact />
              </ErrorBoundary>
            </aside>
          )}

          {showDiagnostics && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="Diagnostics">
                <DiagsPanel onClose={() => setShowDiagnostics(false)} />
              </ErrorBoundary>
            </aside>
          )}
        </ErrorBoundary>
      </main>

      {/* ── Bottom status bar ── */}
      <StatusBar timeframe={timeframe} />

      {absorptionModal && (
        <AbsorptionModal data={absorptionModal} onClose={() => setAbsorptionModal(null)} />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/** Isolated, memoised live-quote strip. Subscribes only to mid/spread/imbalance
 *  so it re-renders on price changes without reconciling the whole header. */
const LiveQuote = memo(function LiveQuote() {
  const q = useLiveField(
    (s) => ({
      mid: s.data?.mid_price ?? 0,
      spread: s.data?.spread ?? 0,
      imbalance: s.data?.imbalance ?? 0,
    }),
    (a, b) => a.mid === b.mid && a.spread === b.spread && a.imbalance === b.imbalance,
  );
  if (!q.mid) return <div className="hidden lg:block" />;
  return (
    <div className="hidden lg:flex items-center gap-3 text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-terminal-panel border border-terminal-border">
        <span className="text-[10px] text-terminal-text-dim">MID</span>
        <span className="font-bold tabular-nums text-sm text-terminal-text">{price(q.mid)}</span>
      </div>
      <div className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs">
        <span className="text-terminal-text-dim">SPREAD:</span>
        <span className="text-terminal-gold font-bold tabular-nums">${q.spread.toFixed(2)}</span>
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

/** Isolated CVD + delta readout and a v7.4 pipeline diagnostic badge. Subscribes
 *  only to the low-frequency order-flow fields (cvd, forming-candle delta, v74
 *  warm state, key-level/sweep counts) so it re-renders independently of the
 *  12-15fps price feed. CVD = session-anchored cumulative volume delta (oz);
 *  the badge confirms the engine pipeline is warm and how many levels/sweeps the
 *  latest frame carries. */
const OrderFlowBadge = memo(function OrderFlowBadge() {
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
    s.cvd == null ? "text-terminal-text-dim" : s.cvd > 0 ? "text-terminal-bull" : s.cvd < 0 ? "text-terminal-bear" : "text-terminal-gold";
  const toneDelta =
    s.delta == null ? "text-terminal-text-dim" : s.delta > 0 ? "text-terminal-bull" : s.delta < 0 ? "text-terminal-bear" : "text-terminal-gold";

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
const SignalDock = memo(function SignalDock(props: {
  tf: ChartTf;
  onTfChange: (tf: ChartTf) => void;
  onClose: () => void;
}) {
  const v74 = useLiveField((s) => s.data?.v74 ?? null);
  return <SignalPanelMemo v74={v74} {...props} />;
});

/** Isolated, memoised footer. Subscribes only to telemetry counters. */
const StatusBar = memo(function StatusBar({ timeframe }: { timeframe: Timeframe }) {
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
        <span className="hidden sm:inline">Binance USDⓈ-M Futures (XAUUSDT)</span>
        <span className="hidden md:inline">
          • SYNC: <span className="text-terminal-gold font-bold uppercase">{t.sync}</span>
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
