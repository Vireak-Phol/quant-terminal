import { memo } from "react";
import type { Timeframe, ChartLayer } from "../../chart/TerminalChart";
import type { ConnectionState } from "../../hooks/useLiveOrderBook";
import { TIMEFRAMES, LAYER_META } from "./constants";
import { LiveQuote } from "./LiveQuote";
import { OrderFlowBadge } from "./OrderFlowBadge";
import { HeatmapFadeMenu } from "./HeatmapFadeMenu";

export interface HeaderToolbarProps {
  timeframe: Timeframe;
  isLoadingKlines: boolean;
  onChangeTimeframe: (tf: Timeframe) => void;
  onResetView: () => void;

  layers: Record<ChartLayer, boolean>;
  onToggleLayer: (key: ChartLayer) => void;

  heatmapFade: boolean;
  fadeStrength: number;
  showFadeMenu: boolean;
  onToggleFadeMenu: () => void;
  onCloseFadeMenu: () => void;
  onToggleHeatmapFade: () => void;
  onChangeFadeStrength: (strength: number) => void;

  showSignals: boolean;
  showDomLadder: boolean;
  showDiagnostics: boolean;
  showOrderFlow: boolean;
  onToggleSignals: () => void;
  onToggleDomLadder: () => void;
  onToggleDiagnostics: () => void;
  onToggleOrderFlow: () => void;

  soundOn: boolean;
  onToggleSound: () => void;

  connectionState: ConnectionState;
  theme: string;
  onCycleTheme: () => void;
}

/** Top cockpit header. Pure/controlled: every bit of state lives in App and is
 *  passed down, so the toolbar re-renders only when a toggle actually changes —
 *  the high-frequency price/CVD feeds are isolated inside <LiveQuote/> and
 *  <OrderFlowBadge/>, which self-subscribe and never reconcile the whole bar. */
export const HeaderToolbar = memo(function HeaderToolbar({
  timeframe,
  isLoadingKlines,
  onChangeTimeframe,
  onResetView,
  layers,
  onToggleLayer,
  heatmapFade,
  fadeStrength,
  showFadeMenu,
  onToggleFadeMenu,
  onCloseFadeMenu,
  onToggleHeatmapFade,
  onChangeFadeStrength,
  showSignals,
  showDomLadder,
  showDiagnostics,
  showOrderFlow,
  onToggleSignals,
  onToggleDomLadder,
  onToggleDiagnostics,
  onToggleOrderFlow,
  soundOn,
  onToggleSound,
  connectionState,
  theme,
  onCycleTheme,
}: HeaderToolbarProps) {
  return (
    <header className="h-12 flex items-center justify-between px-3 border-b border-terminal-border bg-terminal-surface/95 backdrop-blur-md shrink-0 font-mono text-xs z-30">
      {/* Left: identity + timeframe pills + loading */}
      <div className="flex items-center gap-2 sm:gap-2.5">
        <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-terminal-panel border border-terminal-border shadow-xs">
          <div className="w-2 h-2 rounded-full bg-terminal-gold shadow-glow animate-pulse" />
          <span className="font-extrabold tracking-wider text-sm text-terminal-text">
            XAUUSDT
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-terminal-surface border border-terminal-border text-terminal-gold font-bold">
            GPU · USDⓈ-M
          </span>
        </div>

        <div className="h-4 w-px bg-terminal-border/80 mx-0.5" />

        <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => onChangeTimeframe(tf)}
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
            onClick={onResetView}
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
              onClick={() => onToggleLayer(l.key)}
              aria-pressed={layers[l.key]}
              className={`px-2 py-0.5 rounded font-bold transition-all ${
                layers[l.key]
                  ? l.on
                  : "text-terminal-text-dim hover:text-terminal-text"
              }`}
              title={`Toggle ${l.label} layer`}
            >
              {l.glyph} {l.label}
            </button>
          ))}

          <HeatmapFadeMenu
            heatmapEnabled={layers.heatmap}
            heatmapFade={heatmapFade}
            fadeStrength={fadeStrength}
            showMenu={showFadeMenu}
            onToggleMenu={onToggleFadeMenu}
            onCloseMenu={onCloseFadeMenu}
            onToggleFade={onToggleHeatmapFade}
            onChangeStrength={onChangeFadeStrength}
          />
        </div>

        <div className="h-4 w-px bg-terminal-border/80 mx-0.5 hidden md:block" />

        <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5 text-2xs">
          <button
            onClick={onToggleSignals}
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
            onClick={onToggleDomLadder}
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
            onClick={onToggleDiagnostics}
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
            onClick={onToggleOrderFlow}
            aria-pressed={showOrderFlow}
            className={`px-2 py-0.5 rounded font-bold transition-all ${
              showOrderFlow
                ? "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow"
                : "text-terminal-text-dim hover:text-terminal-text"
            }`}
            title="Toggle Order Flow · Bubble Regime Panel (OI + liquidation classified sweeps)"
          >
            🫧 FLOW
          </button>
          <button
            onClick={onToggleSound}
            aria-pressed={soundOn}
            className={`px-2 py-0.5 rounded font-bold transition-all ${
              soundOn
                ? "text-terminal-gold"
                : "text-terminal-text-dim hover:text-terminal-text"
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
        </div>

        <button
          onClick={onCycleTheme}
          className="px-2 py-1 text-2xs font-medium text-terminal-text-dim hover:text-terminal-text bg-terminal-panel hover:bg-terminal-surface border border-terminal-border rounded transition-all"
          title={`Current theme: ${theme}`}
        >
          <span className="text-terminal-accent uppercase font-bold">
            {theme}
          </span>
        </button>
      </div>
    </header>
  );
});
