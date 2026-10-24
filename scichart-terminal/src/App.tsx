import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefs } from "./store/usePrefs";
import {
  getSharedSocket,
  DEFAULT_BRIDGE_URL,
  DEFAULT_VENUE,
  type VenueInfo,
} from "./hooks/useLiveOrderBook";
import { useLiveField } from "./hooks/useLiveField";
import { useVenue } from "./hooks/useVenue";
import {
  TerminalChart,
  type Timeframe,
  type ChartLayer,
  type ChartFrame,
} from "./chart/TerminalChart";
import { configureSciChart } from "./chart/scichart-init";
import { fetchChartKlines } from "./lib/klines";
import { loadChartStyle, saveChartStyle, type ChartStyle } from "./lib/chartStyle";
import { price } from "./lib/format";
import { newAplusSignals, playChime } from "./lib/alerts";
import { probabilityView, setupLabel } from "./lib/v74";
import type { ChartTf } from "./types/v74";
import { OrderBookLadder } from "./components/Dashboard/OrderBookLadder";
import { DiagnosticsPanel } from "./components/Dashboard/DiagnosticsPanel";
import { OrderFlowPanel } from "./components/Dashboard/OrderFlowPanel";
import {
  AbsorptionModal,
  type AbsorptionModalData,
} from "./components/Dashboard/AbsorptionModal";
import { ToastContainer, type ToastMessage } from "./components/Shared/Toast";
import {
  CrosshairLegend,
  type CrosshairLegendHandle,
} from "./components/Dashboard/CrosshairLegend";
import { ErrorBoundary } from "./components/Shared/ErrorBoundary";
import { HeaderToolbar } from "./components/Header/HeaderToolbar";
import { StatusBar } from "./components/Header/StatusBar";
import { SignalDock } from "./components/Header/SignalDock";
import { CHART_DIV_ID, HISTORY_LIMIT, LAYER_META } from "./components/Header/constants";

configureSciChart();

// Memoised panels: only re-render when their own props / subscriptions change,
// never because the parent App re-rendered.
const LadderPanel = memo(OrderBookLadder);
const DiagsPanel = memo(DiagnosticsPanel);
const FlowPanel = memo(OrderFlowPanel);

export default function App() {
  const { prefs, cycleTheme } = usePrefs();

  // App only subscribes to low-frequency status fields; the per-frame price feed
  // is handled imperatively below (refs + rAF) so the whole tree does not
  // reconcile 12-15×/sec.
  const { connectionState } = useLiveField(
    (s) => ({ connectionState: s.connectionState, latencyMs: s.latencyMs }),
    (a, b) =>
      a.connectionState === b.connectionState && a.latencyMs === b.latencyMs,
  );

  const chartRef = useRef<TerminalChart | null>(null);
  const readyRef = useRef(false);

  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const timeframeRef = useRef<Timeframe>("1m");
  const [isLoadingKlines, setIsLoadingKlines] = useState(false);

  // Active market-data venue (Binance / OANDA) — drives labels + layer gating.
  const venue = useVenue();
  const venueRef = useRef<VenueInfo>(DEFAULT_VENUE);

  const [crosshair, setCrosshair] = useState<boolean>(
    () => localStorage.getItem("terminal.crosshair") !== "off",
  );
  const legendRef = useRef<CrosshairLegendHandle | null>(null);

  // Candle + bubble colours (persisted). Pushed to the chart and to CSS variables
  // used by the OHLC legend so the readout matches the candles.
  const [chartStyle, setChartStyle] = useState<ChartStyle>(loadChartStyle);
  const chartStyleRef = useRef(chartStyle);
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  useEffect(() => {
    chartStyleRef.current = chartStyle;
    saveChartStyle(chartStyle);
    chartRef.current?.setStyle(chartStyle);
    const root = document.documentElement.style;
    root.setProperty("--legend-up", chartStyle.candleUpWick);
    root.setProperty("--legend-down", chartStyle.candleDownWick);
  }, [chartStyle]);
  const toggleStyleMenu = useCallback(() => setShowStyleMenu((v) => !v), []);
  const closeStyleMenu = useCallback(() => setShowStyleMenu(false), []);

  const [layers, setLayers] = useState<Record<ChartLayer, boolean>>({
    heatmap: true,
    bubbles: true,
    vacuum: true,
    hopla: true,
    vwap: true,
    delta: false,
  });

  // Layers the active venue cannot feed. OANDA streams quotes only: no market depth
  // (heatmap) and no exchange aggressor delta. Gated layers render nothing.
  const layerUnavailable = useMemo<Record<ChartLayer, string | null>>(() => {
    const caps = venue.capabilities;
    return {
      heatmap: caps.l2_depth ? null : `${venue.label} has no market depth (quotes only)`,
      bubbles: null,
      vacuum: null,
      hopla: null,
      vwap: null,
      delta: caps.delta === "exchange" ? null : `${venue.label} has no aggressor (taker) volume`,
    };
  }, [venue]);
  const effectiveLayers = useMemo(() => {
    const out = { ...layers };
    for (const k of Object.keys(out) as ChartLayer[]) if (layerUnavailable[k]) out[k] = false;
    return out;
  }, [layers, layerUnavailable]);

  const [heatmapFade, setHeatmapFade] = useState<boolean>(() => {
    const saved = localStorage.getItem("terminal.heatmapFade");
    return saved !== null ? saved === "true" : true;
  });
  const [fadeStrength, setFadeStrength] = useState<number>(() => {
    const saved = localStorage.getItem("terminal.heatmapFadeStrength");
    return saved ? parseFloat(saved) : 0.7;
  });
  const [showFadeMenu, setShowFadeMenu] = useState(false);

  // Audit #6: keep state setters pure. Persisting to localStorage and pushing to
  // the imperative chart are *effects*, not part of the reducer — doing them in
  // the updater double-fires under StrictMode and races `heatmapFade` vs
  // `fadeStrength`. A single effect reacting to both keeps the chart in sync and
  // runs exactly once per committed value.
  useEffect(() => {
    localStorage.setItem("terminal.heatmapFade", String(heatmapFade));
    localStorage.setItem("terminal.heatmapFadeStrength", String(fadeStrength));
    chartRef.current?.setHeatmapFade(heatmapFade, fadeStrength);
  }, [heatmapFade, fadeStrength]);

  const toggleHeatmapFade = useCallback(() => setHeatmapFade((p) => !p), []);
  const changeFadeStrength = useCallback(
    (strength: number) => setFadeStrength(strength),
    [],
  );
  const toggleFadeMenu = useCallback(() => setShowFadeMenu((v) => !v), []);
  const closeFadeMenu = useCallback(() => setShowFadeMenu(false), []);

  const [showSignals, setShowSignals] = useState(true);
  const [showDomLadder, setShowDomLadder] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showOrderFlow, setShowOrderFlow] = useState(false);
  const [signalTf, setSignalTf] = useState<ChartTf>("5m");

  const toggleSignals = useCallback(() => setShowSignals((v) => !v), []);
  const toggleDomLadder = useCallback(() => setShowDomLadder((v) => !v), []);
  const toggleDiagnostics = useCallback(() => setShowDiagnostics((v) => !v), []);
  const toggleOrderFlow = useCallback(() => setShowOrderFlow((v) => !v), []);

  const [soundOn, setSoundOn] = useState<boolean>(
    () => localStorage.getItem("terminal.alertSound") !== "off",
  );
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    soundOnRef.current = soundOn;
    localStorage.setItem("terminal.alertSound", soundOn ? "on" : "off");
  }, [soundOn]);
  const toggleSound = useCallback(() => setSoundOn((v) => !v), []);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [absorptionModal, setAbsorptionModal] =
    useState<AbsorptionModalData | null>(null);

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

  // Keep a ref of layer state for the init effect (it must not re-run on toggle).
  const layersRef = useRef(effectiveLayers);
  useEffect(() => {
    layersRef.current = effectiveLayers;
  }, [effectiveLayers]);

  const crosshairRef = useRef(crosshair);

  // Latest fade settings for the async init effect, without re-running it.
  const fadeRef = useRef({ heatmapFade, fadeStrength });
  useEffect(() => {
    fadeRef.current = { heatmapFade, fadeStrength };
  }, [heatmapFade, fadeStrength]);

  // ── Kline seeding (bridge → active venue; Binance-direct fallback) ─────────
  // A monotonically increasing token drops stale responses when the timeframe or
  // venue changes while a request is in flight.
  const loadSeqRef = useRef(0);
  const loadKlines = useCallback(
    async (tf: Timeframe) => {
      const seq = ++loadSeqRef.current;
      const v = venueRef.current ?? DEFAULT_VENUE;
      setIsLoadingKlines(true);
      try {
        const res = await fetchChartKlines(
          getSharedSocket(DEFAULT_BRIDGE_URL),
          v.name,
          v.symbol,
          tf,
          HISTORY_LIMIT,
        );
        if (seq !== loadSeqRef.current || timeframeRef.current !== tf) return;
        if (res.candles.length > 0) chartRef.current?.loadHistoricalCandles(res.candles);
        else if (res.error) addToastRef.current(`History unavailable: ${res.error}`, "bear");
      } finally {
        if (seq === loadSeqRef.current) setIsLoadingKlines(false);
      }
    },
    [],
  );
  const loadKlinesRef = useRef(loadKlines);
  useEffect(() => {
    loadKlinesRef.current = loadKlines;
  }, [loadKlines]);
  const addToastRef = useRef(addToast);
  useEffect(() => {
    addToastRef.current = addToast;
  }, [addToast]);

  // ── Crosshair legend: updated imperatively (pointer moves / frames), coalesced
  //    to one DOM write per animation frame. React never re-renders on hover.
  const legendRafRef = useRef(0);
  const scheduleLegend = useCallback(() => {
    if (legendRafRef.current) return;
    legendRafRef.current = requestAnimationFrame(() => {
      legendRafRef.current = 0;
      legendRef.current?.update(
        crosshairRef.current ? chartRef.current?.getReadout() ?? null : null,
      );
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(legendRafRef.current), []);

  useEffect(() => {
    crosshairRef.current = crosshair;
    localStorage.setItem("terminal.crosshair", crosshair ? "on" : "off");
    chartRef.current?.setCrosshair(crosshair);
    scheduleLegend();
  }, [crosshair, scheduleLegend]);
  const toggleCrosshair = useCallback(() => setCrosshair((v) => !v), []);

  // ── Chart lifecycle (StrictMode-safe) ────────────────────────────────────
  // The cleanup awaits the in-flight async init so the surface created by a
  // double-invoked effect is always torn down — no orphaned WebGL context.
  useEffect(() => {
    let disposed = false;
    const chart = new TerminalChart({
      tickSize: 0.5,
      timeframe: timeframeRef.current,
    });
    chart.setStyle(chartStyleRef.current); // construction colours, before init()
    const initPromise = chart
      .init(CHART_DIV_ID)
      .then(async () => {
        if (disposed) return;
        chartRef.current = chart;
        readyRef.current = true;
        chart.setHeatmapFade(
          fadeRef.current.heatmapFade,
          fadeRef.current.fadeStrength,
        );
        for (const { key } of LAYER_META)
          chart.setLayerVisibility(key, layersRef.current[key]);
        chart.setCrosshair(crosshairRef.current);
        chart.setPointerListener(scheduleLegend);
        await loadKlinesRef.current(timeframeRef.current);
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

  // ── Per-frame pipeline: subscribe imperatively, coalesce with rAF ─────────
  // The websocket emits ~12-15 fps; we keep only the newest frame and drain it
  // to the GPU once per animation frame while the tab is visible. Intermediate
  // frames are dropped. This decouples chart + alert work from the raw socket
  // rate and caps it at the display refresh — the single biggest protection
  // against the tab becoming unresponsive during volatility / replay bursts.
  //
  // BACKGROUND-TAB CONTRACT: requestAnimationFrame is paused by the browser when
  // the tab is hidden, which previously froze the chart (the active candle and
  // absorption bubbles only "caught up" when you refocused the tab). We fall
  // back to a setInterval-driven drain while `document.hidden`, so the active
  // candle, heatmap and bubbles keep advancing off-screen. Browsers clamp
  // background timers to ~1s, which is plenty for an off-screen chart and still
  // far better than a fully frozen one.
  useEffect(() => {
    const socket = getSharedSocket(DEFAULT_BRIDGE_URL);
    let rafId = 0;
    let intervalId: ReturnType<typeof setInterval> | 0 = 0;
    let pending = false;

    const drain = () => {
      rafId = 0;
      pending = false;
      const snap = socket.getSnapshot();
      const frame = snap.data as ChartFrame | null;
      if (!frame) return;

      // Venue switch (bridge restarted on another provider): everything on the chart
      // came from the old feed — wipe it, forget seen signals, reseed history.
      const v = snap.data?.venue ?? DEFAULT_VENUE;
      const prevVenue = venueRef.current;
      venueRef.current = v;
      if (prevVenue && prevVenue.name !== v.name) {
        seenSignalIds.current.clear();
        firstV74Ref.current = true;
        if (readyRef.current && chartRef.current) {
          chartRef.current.resetForVenue();
          void loadKlinesRef.current(timeframeRef.current);
        }
      }

      if (readyRef.current && chartRef.current) {
        chartRef.current.update(frame);
        scheduleLegend();
      }

      // A+ signal alerts (v74 changes only on closed bars, so this is cheap).
      const v74 = (
        snap.data as { v74?: Parameters<typeof newAplusSignals>[0] } | null
      )?.v74;
      if (v74) {
        const fresh = newAplusSignals(
          v74,
          seenSignalIds.current,
          firstV74Ref.current,
        );
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

    // Visible tab → coalesce at display refresh via rAF (one frame per vsync).
    const scheduleRaf = () => {
      if (pending || document.hidden) return;
      pending = true;
      rafId = requestAnimationFrame(drain);
    };

    // Hidden tab → rAF is paused; a throttled interval keeps the chart alive.
    const startHiddenPump = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        // Guard against a double-drain racing a queued rAF.
        if (!pending) drain();
      }, 250);
    };
    const stopHiddenPump = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = 0;
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        // Cancel any queued rAF (it won't fire anyway) and pump via interval.
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
          pending = false;
        }
        startHiddenPump();
      } else {
        // Back in the foreground: stop the interval, draw the latest frame now,
        // then resume rAF-paced draining.
        stopHiddenPump();
        drain();
      }
    };

    // On each websocket frame: rAF when visible, otherwise rely on the pump.
    const onFrame = () => {
      if (document.hidden) startHiddenPump();
      else scheduleRaf();
    };

    const unsubscribe = socket.subscribe(onFrame);
    document.addEventListener("visibilitychange", onVisibility);
    // Draw the current snapshot immediately on mount (respecting visibility).
    onFrame();

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      if (rafId) cancelAnimationFrame(rafId);
      stopHiddenPump();
    };
  }, [addToast, scheduleLegend]);

  // ── Timeframe switching ──────────────────────────────────────────────────
  const changeTimeframe = useCallback(async (tf: Timeframe) => {
    if (tf === timeframeRef.current) return;
    timeframeRef.current = tf;
    setTimeframe(tf);
    chartRef.current?.setTimeframe(tf);
    await loadKlines(tf);
  }, [loadKlines]);

  const resetView = useCallback(() => chartRef.current?.resetView(), []);

  // ── Layer toggles ────────────────────────────────────────────────────────
  // The chart mutation is an effect of the committed `layers` value, not part of
  // the updater — keeps the setter pure under StrictMode (Audit #6).
  const toggleLayer = useCallback((key: ChartLayer) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const { key } of LAYER_META) chart.setLayerVisibility(key, effectiveLayers[key]);
  }, [effectiveLayers]);

  // ── Click-to-inspect absorption bubbles ──────────────────────────────────
  const onChartClick = useCallback(() => {
    const hit = chartRef.current?.hitTestBubble(18);
    if (hit) {
      setAbsorptionModal({
        time: hit.point?.time ?? hit.x,
        anchorPrice: hit.point?.price ?? hit.y,
        side: hit.side,
        point: hit.point,
      });
    }
  }, []);

  // ── Keyboard: Alt+D toggles DOM ladder ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      // e.code: Alt+letter yields a dead/special char on macOS ("∂", "ç").
      if (e.code === "KeyD") {
        e.preventDefault();
        setShowDomLadder((v) => !v);
      } else if (e.code === "KeyC") {
        e.preventDefault();
        setCrosshair((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-terminal-bg text-terminal-text overflow-hidden font-sans select-none">
      <HeaderToolbar
        timeframe={timeframe}
        isLoadingKlines={isLoadingKlines}
        onChangeTimeframe={changeTimeframe}
        onResetView={resetView}
        layers={effectiveLayers}
        onToggleLayer={toggleLayer}
        layerUnavailable={layerUnavailable}
        crosshair={crosshair}
        onToggleCrosshair={toggleCrosshair}
        chartStyle={chartStyle}
        showStyleMenu={showStyleMenu}
        onToggleStyleMenu={toggleStyleMenu}
        onCloseStyleMenu={closeStyleMenu}
        onChangeChartStyle={setChartStyle}
        onNotify={addToast}
        heatmapFade={heatmapFade}
        fadeStrength={fadeStrength}
        showFadeMenu={showFadeMenu}
        onToggleFadeMenu={toggleFadeMenu}
        onCloseFadeMenu={closeFadeMenu}
        onToggleHeatmapFade={toggleHeatmapFade}
        onChangeFadeStrength={changeFadeStrength}
        showSignals={showSignals}
        showDomLadder={showDomLadder}
        showDiagnostics={showDiagnostics}
        showOrderFlow={showOrderFlow}
        onToggleSignals={toggleSignals}
        onToggleDomLadder={toggleDomLadder}
        onToggleDiagnostics={toggleDiagnostics}
        onToggleOrderFlow={toggleOrderFlow}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        connectionState={connectionState}
        theme={prefs.theme}
        onCycleTheme={cycleTheme}
      />

      {/* ── Workspace: chart + right docks ── */}
      <main className="flex-1 w-full min-h-0 relative flex overflow-hidden bg-terminal-bg">
        <ErrorBoundary title="Chart Workspace">
          <div className="flex-1 h-full min-h-0 relative overflow-hidden">
            <div
              id={CHART_DIV_ID}
              onClick={onChartClick}
              className="absolute inset-0"
              aria-label={`${venue.display_symbol} price chart`}
              role="img"
            />
            <CrosshairLegend
              ref={legendRef}
              volumeKind={venue.capabilities.volume}
              deltaKind={venue.capabilities.delta}
            />
          </div>

          {showSignals && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="Signal Panel">
                <SignalDock
                  tf={signalTf}
                  onTfChange={setSignalTf}
                  onClose={toggleSignals}
                />
              </ErrorBoundary>
            </aside>
          )}

          {showDomLadder && (
            <aside className="w-72 lg:w-80 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="DOM Ladder">
                <LadderPanel onClose={toggleDomLadder} compact />
              </ErrorBoundary>
            </aside>
          )}

          {showDiagnostics && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="Diagnostics">
                <DiagsPanel onClose={toggleDiagnostics} />
              </ErrorBoundary>
            </aside>
          )}

          {showOrderFlow && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <ErrorBoundary title="Order Flow">
                <FlowPanel onClose={toggleOrderFlow} />
              </ErrorBoundary>
            </aside>
          )}
        </ErrorBoundary>
      </main>

      {/* ── Bottom status bar ── */}
      <StatusBar timeframe={timeframe} />

      {absorptionModal && (
        <AbsorptionModal
          data={absorptionModal}
          onClose={() => setAbsorptionModal(null)}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
