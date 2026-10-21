import React, { useState, useCallback, useEffect, useRef } from "react";
import { usePrefs } from "./store/usePrefs";
import { useLiveOrderBook } from "./hooks/useLiveOrderBook";
import { price } from "./lib/format";
import { TimeframeInterval } from "./lib/klines";
import { TradingViewDeepChart } from "./components/Dashboard/TradingViewDeepChart";
import { BookmapChart } from "./components/Dashboard/BookmapChart";
import { OrderBookLadder } from "./components/Dashboard/OrderBookLadder";
import { V7SignalPanel } from "./components/Dashboard/V7SignalPanel";
import { DiagnosticsPanel } from "./components/Dashboard/DiagnosticsPanel";
import { ToastContainer, ToastMessage } from "./components/Shared/Toast";
import { ErrorBoundary } from "./components/Shared/ErrorBoundary";

export default function App() {
  const { prefs, cycleTheme } = usePrefs();
  const { data: liveBook, connectionState, latencyMs } = useLiveOrderBook();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Master TradingView Controls State
  const [interval, setInterval] = useState<TimeframeInterval>("5m");
  const [activeView, setActiveView] = useState<
    "tradingview" | "bookmap" | "split"
  >("tradingview");
  const [showBubbles, setShowBubbles] = useState<boolean>(true);
  const [showZones, setShowZones] = useState<boolean>(true);
  const [showWalls, setShowWalls] = useState<boolean>(true);
  const [showDomLadder, setShowDomLadder] = useState<boolean>(false);
  const [showSignals, setShowSignals] = useState<boolean>(false);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Real-time price uptick/downtick pulse
  const [priceFlash, setPriceFlash] = useState<"up" | "down" | null>(null);
  const prevPriceRef = useRef<number>(0);
  const lastSignalIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!liveBook || liveBook.mid_price === 0) return;
    if (
      prevPriceRef.current > 0 &&
      liveBook.mid_price !== prevPriceRef.current
    ) {
      if (liveBook.mid_price > prevPriceRef.current) {
        setPriceFlash("up");
      } else {
        setPriceFlash("down");
      }
      const t = setTimeout(() => setPriceFlash(null), 400);
      return () => clearTimeout(t);
    }
    prevPriceRef.current = liveBook.mid_price;
  }, [liveBook?.mid_price]);

  // Fullscreen management
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch(() => {});
    } else {
      document
        .exitFullscreen()
        .then(() => setIsFullscreen(false))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFsChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const addToast = useCallback(
    (message: string, type: "info" | "warn" | "bull" | "bear" = "info") => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev, { id, message, type }]);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auto-alert toast when a new Tier-1 A+ setup triggers (minimum 60s cooldown)
  const lastToastTimeRef = useRef<number>(0);
  useEffect(() => {
    const sig = liveBook?.v7_signal;
    if (!sig || sig.tier !== "TIER_1_A_PLUS") return;
    const now = Date.now();
    if (
      sig.id !== lastSignalIdRef.current &&
      now - lastToastTimeRef.current > 60000
    ) {
      lastSignalIdRef.current = sig.id;
      lastToastTimeRef.current = now;
      addToast(
        `${sig.tier_label}: Entry $${sig.entry_price.toFixed(2)}, SL $${sig.stop_loss.toFixed(2)} (${sig.win_probability}% Win Prob)`,
        sig.direction === "LONG" ? "bull" : "bear",
      );
    }
  }, [liveBook?.v7_signal, addToast]);

  return (
    <div className="h-screen flex flex-col bg-terminal-bg text-terminal-text overflow-hidden font-sans select-none">
      {/* TradingView Top Navigation Header Bar */}
      <header className="h-12 flex items-center justify-between px-3 border-b border-terminal-border bg-terminal-surface/95 backdrop-blur-md shrink-0 font-mono text-xs select-none z-30">
        {/* Left Wing: Asset Identity + Timeframe Pills + View Mode */}
        <div className="flex items-center gap-2 sm:gap-2.5">
          {/* Ticker Chip */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-terminal-panel border border-terminal-border shadow-xs">
            <div className="w-2 h-2 rounded-full bg-terminal-gold shadow-glow animate-pulse" />
            <span className="font-extrabold tracking-wider text-sm text-terminal-text">
              XAUUSDT
            </span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-terminal-surface border border-terminal-border text-terminal-gold font-bold">
              USDⓈ-M FUTURES
            </span>
          </div>

          <div className="h-4 w-px bg-terminal-border/80 mx-0.5" />

          {/* Timeframe Selector Pills */}
          <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5">
            {(["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const).map(
              (tf) => (
                <button
                  key={tf}
                  onClick={() => setInterval(tf)}
                  className={`px-2 py-0.5 rounded font-bold transition-all text-2xs ${
                    interval === tf
                      ? "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow"
                      : "text-terminal-text-dim hover:text-terminal-text hover:bg-terminal-surface"
                  }`}
                  title={`Switch to ${tf} timeframe`}
                >
                  {tf}
                </button>
              ),
            )}
          </div>

          <div className="h-4 w-px bg-terminal-border/80 mx-0.5 hidden md:block" />

          {/* View Mode Switcher (TradingView, Bookmap, Split) */}
          <div className="hidden md:flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5 text-2xs">
            <button
              onClick={() => setActiveView("tradingview")}
              className={`px-2.5 py-0.5 rounded font-semibold transition-all ${
                activeView === "tradingview"
                  ? "bg-terminal-surface text-terminal-gold border border-terminal-border font-bold shadow-xs"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Full-Screen Candlestick Chart"
            >
              📊 CANDLES
            </button>
            <button
              onClick={() => setActiveView("bookmap")}
              className={`px-2.5 py-0.5 rounded font-semibold transition-all ${
                activeView === "bookmap"
                  ? "bg-terminal-surface text-terminal-gold border border-terminal-border font-bold shadow-xs"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Institutional Bookmap Heatmap"
            >
              🔥 BOOKMAP
            </button>
            <button
              onClick={() => setActiveView("split")}
              className={`px-2.5 py-0.5 rounded font-semibold transition-all ${
                activeView === "split"
                  ? "bg-terminal-surface text-terminal-gold border border-terminal-border font-bold shadow-xs"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Dual Side-by-Side Chart View"
            >
              ◫ SPLIT
            </button>
          </div>
        </div>

        {/* Center Wing: Live Quote Ticker & Microstructure Metrics */}
        {liveBook && liveBook.mid_price > 0 && (
          <div className="hidden lg:flex items-center gap-3 text-xs font-mono">
            {/* Live Mid Price with Tick Animation */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-terminal-panel border border-terminal-border">
              <span className="text-[10px] text-terminal-text-dim">MID</span>
              <span
                className={`font-bold tabular-nums text-sm transition-colors duration-200 ${
                  priceFlash === "up"
                    ? "text-terminal-bull animate-pulse"
                    : priceFlash === "down"
                      ? "text-terminal-bear animate-pulse"
                      : "text-terminal-text"
                }`}
              >
                {price(liveBook.mid_price)}
              </span>
            </div>

            {/* Live Spread */}
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs">
              <span className="text-terminal-text-dim">SPREAD:</span>
              <span className="text-terminal-gold font-bold tabular-nums">
                ${liveBook.spread.toFixed(2)}
              </span>
            </div>

            {/* OFI Imbalance Flow */}
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs">
              <span className="text-terminal-text-dim">FLOW:</span>
              <span
                className={`font-bold uppercase ${
                  liveBook.imbalance > 0.15
                    ? "text-terminal-bull"
                    : liveBook.imbalance < -0.15
                      ? "text-terminal-bear"
                      : "text-terminal-gold"
                }`}
              >
                {liveBook.imbalance > 0
                  ? `+${(liveBook.imbalance * 100).toFixed(0)}% BULL`
                  : liveBook.imbalance < 0
                    ? `${(liveBook.imbalance * 100).toFixed(0)}% BEAR`
                    : "BALANCED"}
              </span>
            </div>

            {/* Active Resting Zones Badge */}
            {liveBook.liquidity_zones &&
              liveBook.liquidity_zones.length > 0 && (
                <div className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs">
                  <span className="text-emerald-400 font-bold">
                    ⚡{" "}
                    {
                      liveBook.liquidity_zones.filter(
                        (z) => z.status !== "removed",
                      ).length
                    }{" "}
                    ZONES
                  </span>
                </div>
              )}
          </div>
        )}

        {/* Right Wing: Overlay Toggles + DOM Ladder + Diagnostics + Theme/FS */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Chart Overlays Controls */}
          <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5 text-2xs">
            <button
              onClick={() => setShowZones(!showZones)}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showZones
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle Resting Liquidity Zones Overlay"
            >
              ⚡ ZONES
            </button>
            <button
              onClick={() => setShowBubbles(!showBubbles)}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showBubbles
                  ? "bg-terminal-bull/20 text-terminal-bull border border-terminal-bull/40 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle TradingView Heavy Absorption Indicator"
            >
              🫧 ABSORPTION
            </button>
            <button
              onClick={() => setShowSignals(!showSignals)}
              className={`px-2 py-0.5 rounded font-bold transition-all flex items-center gap-1 ${
                showSignals
                  ? "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle v7.4 Institutional Signals Panel"
            >
              <span>★ SIGNALS</span>
            </button>
            <button
              onClick={() => setShowDomLadder(!showDomLadder)}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showDomLadder
                  ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle L2 Order Book DOM Ladder"
            >
              📊 DOM
            </button>
            <button
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                showDiagnostics
                  ? "bg-purple-500/25 text-purple-300 border border-purple-500/50 shadow-glow"
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title="Toggle Observability & Diagnostics Panel"
            >
              🩺 DIAGS
            </button>
          </div>

          <div className="h-4 w-px bg-terminal-border/80 mx-0.5" />

          {/* Connection Status Pill */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-semibold bg-terminal-panel border border-terminal-border">
            <span
              className={`w-2 h-2 rounded-full ${
                connectionState === "connected"
                  ? "bg-terminal-bull animate-pulse"
                  : "bg-terminal-bear"
              }`}
            />
            <span className="text-terminal-text-dim min-w-12 uppercase hidden sm:inline">
              {connectionState === "connected" ? `${latencyMs}ms` : "OFFLINE"}
            </span>
          </div>

          {/* Theme Cycler */}
          <button
            onClick={cycleTheme}
            className="px-2 py-1 text-2xs font-medium text-terminal-text-dim hover:text-terminal-text bg-terminal-panel hover:bg-terminal-surface border border-terminal-border rounded transition-all"
            title={`Current theme: ${prefs.theme}`}
          >
            <span className="text-terminal-accent uppercase font-bold">
              {prefs.theme}
            </span>
          </button>

          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            className="px-2 py-1 text-2xs font-medium text-terminal-text-dim hover:text-terminal-text bg-terminal-panel hover:bg-terminal-surface border border-terminal-border rounded transition-all"
            title="Toggle Fullscreen"
          >
            {isFullscreen ? "✕" : "⛶"}
          </button>
        </div>
      </header>

      {/* Main Full-Bleed Edge-to-Edge Chart Workspace */}
      <main className="flex-1 w-full min-h-0 relative flex overflow-hidden bg-terminal-bg">
        <ErrorBoundary title="Chart Workspace">
          {/* Main Chart Area */}
          <div className="flex-1 h-full min-h-0 relative flex overflow-hidden">
            {activeView === "tradingview" && (
              <TradingViewDeepChart
                interval={interval}
                onIntervalChange={setInterval}
                showBubbles={showBubbles}
                onToggleBubbles={() => setShowBubbles(!showBubbles)}
                showZones={showZones}
                onToggleZones={() => setShowZones(!showZones)}
                showWalls={showWalls}
                onToggleWalls={() => setShowWalls(!showWalls)}
                showHeader={false}
              />
            )}

            {activeView === "bookmap" && <BookmapChart hideHeader={true} />}

            {activeView === "split" && (
              <div className="flex w-full h-full min-h-0 overflow-hidden">
                <div className="w-7/12 h-full min-h-0 border-r border-terminal-border">
                  <TradingViewDeepChart
                    interval={interval}
                    onIntervalChange={setInterval}
                    showBubbles={showBubbles}
                    onToggleBubbles={() => setShowBubbles(!showBubbles)}
                    showZones={showZones}
                    onToggleZones={() => setShowZones(!showZones)}
                    showWalls={showWalls}
                    onToggleWalls={() => setShowWalls(!showWalls)}
                    showHeader={false}
                  />
                </div>
                <div className="w-5/12 h-full min-h-0">
                  <BookmapChart hideHeader={true} />
                </div>
              </div>
            )}
          </div>

          {/* Dockable Right v7.4 Institutional Signals Sidebar */}
          {showSignals && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <V7SignalPanel
                signal={liveBook?.v7_signal}
                hopla={liveBook?.hopla}
                activeFvgs={liveBook?.active_fvgs}
                midPrice={liveBook?.mid_price}
                onClose={() => setShowSignals(false)}
              />
            </aside>
          )}

          {/* Dockable Right L2 Order Book DOM Sidebar */}
          {showDomLadder && (
            <aside className="w-72 lg:w-80 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <OrderBookLadder
                onClose={() => setShowDomLadder(false)}
                compact={true}
              />
            </aside>
          )}

          {/* Dockable Right Diagnostics Sidebar */}
          {showDiagnostics && (
            <aside className="w-80 lg:w-96 h-full min-h-0 border-l border-terminal-border bg-terminal-surface/95 shrink-0 z-20 shadow-2xl flex flex-col">
              <DiagnosticsPanel onClose={() => setShowDiagnostics(false)} />
            </aside>
          )}
        </ErrorBoundary>
      </main>

      {/* Minimalist TradingView Bottom Status Bar */}
      <footer className="h-6 px-3 border-t border-terminal-border/70 bg-terminal-surface/95 flex items-center justify-between text-[11px] font-mono text-terminal-text-dim shrink-0 select-none z-30">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-terminal-bull font-bold">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-bull animate-pulse" />
            ENGINE ACTIVE
          </span>
          <span className="hidden sm:inline">
            Binance USDⓈ-M Futures (XAUUSDT TRADIFI_PERPETUAL)
          </span>
          <span className="hidden md:inline">
            • SYNC:{" "}
            <span className="text-terminal-gold font-bold uppercase">
              {liveBook?.telemetry?.order_book_sync_state || "SYNCHRONIZED"}
            </span>
          </span>
        </div>

        <div className="hidden lg:flex items-center gap-3 text-2xs">
          <span>{interval} Candlesticks</span>
          <span>• Resting Liquidity Zones</span>
          <span>• DeepChart Absorptions</span>
          <span>• Pure Microstructure</span>
        </div>

        <div className="flex items-center gap-3">
          <span>
            Events: {liveBook?.telemetry?.total_updates_processed ?? 0}
          </span>
          <span className="hidden sm:inline">• Lightweight-Charts v5</span>
        </div>
      </footer>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
