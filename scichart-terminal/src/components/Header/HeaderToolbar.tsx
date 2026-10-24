import { memo } from "react";
import type { Timeframe, ChartLayer } from "../../chart/TerminalChart";
import type { ConnectionState } from "../../hooks/useLiveOrderBook";
import { TIMEFRAMES, LAYER_META } from "./constants";
import { LiveQuote } from "./LiveQuote";
import { OrderFlowBadge } from "./OrderFlowBadge";
import { HeatmapFadeMenu } from "./HeatmapFadeMenu";
import { ToolbarButton, ToolbarDivider, ToolbarGroup } from "./ToolbarButton";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { ChartStyleMenu } from "./ChartStyleMenu";
import type { ChartStyle } from "../../lib/chartStyle";

export interface HeaderToolbarProps {
  timeframe: Timeframe;
  isLoadingKlines: boolean;
  onChangeTimeframe: (tf: Timeframe) => void;
  onResetView: () => void;

  layers: Record<ChartLayer, boolean>;
  onToggleLayer: (key: ChartLayer) => void;
  /** Per-layer reason the active venue cannot feed it (null = available). */
  layerUnavailable: Record<ChartLayer, string | null>;

  crosshair: boolean;
  onToggleCrosshair: () => void;
  chartStyle: ChartStyle;
  showStyleMenu: boolean;
  onToggleStyleMenu: () => void;
  onCloseStyleMenu: () => void;
  onChangeChartStyle: (s: ChartStyle) => void;
  onNotify: (msg: string, type?: "info" | "bull" | "bear") => void;

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

const CONNECTION: Record<ConnectionState, { dot: string; text: string; label: string }> = {
  connected: { dot: "bg-terminal-bull", text: "text-terminal-bull", label: "Live" },
  connecting: { dot: "bg-terminal-warn animate-pulse", text: "text-terminal-warn", label: "Connecting" },
  disconnected: { dot: "bg-terminal-bear", text: "text-terminal-bear", label: "Offline" },
};

/** Top cockpit header.
 *
 *  Layout is a 3-column grid (identity | market data | controls). The centre column
 *  is `minmax(0,1fr)` + overflow-hidden, so when the window narrows the market-data
 *  strip shrinks/hides instead of pushing buttons onto a second line. Every button
 *  is `whitespace-nowrap` with a fixed h-7, and toggle labels collapse to icon-only
 *  below the 2xl breakpoint (the tooltip keeps the name).
 *
 *  Pure/controlled: all state lives in App. The high-frequency price/CVD feeds are
 *  isolated inside <LiveQuote/> and <OrderFlowBadge/>, which self-subscribe. */
export const HeaderToolbar = memo(function HeaderToolbar({
  timeframe,
  isLoadingKlines,
  onChangeTimeframe,
  onResetView,
  layers,
  onToggleLayer,
  layerUnavailable,
  crosshair,
  onToggleCrosshair,
  chartStyle,
  showStyleMenu,
  onToggleStyleMenu,
  onCloseStyleMenu,
  onChangeChartStyle,
  onNotify,
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
  const conn = CONNECTION[connectionState] ?? CONNECTION.disconnected;

  return (
    <header className="h-12 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 border-b border-terminal-border bg-terminal-surface/95 backdrop-blur-md shrink-0 font-mono text-xs z-30">
      {/* ── Left: instrument + timeframe ─────────────────────────────── */}
      <div className="flex items-center gap-2 shrink-0">
        <ProviderSwitcher onNotify={onNotify} />

        <ToolbarGroup label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <ToolbarButton
              key={tf}
              label={tf}
              active={tf === timeframe}
              tone="gold"
              title={`${tf} candles`}
              onClick={() => onChangeTimeframe(tf)}
              className="min-w-[2.25rem]"
            />
          ))}
          <ToolbarDivider className="mx-0.5 !h-4" />
          <ToolbarButton
            icon="live"
            label="Live"
            collapseLabel
            title="Snap back to the live edge (double-click chart)"
            onClick={onResetView}
          />
          <ToolbarButton
            icon="crosshair"
            active={crosshair}
            tone="info"
            title={`Crosshair + OHLC readout — ${crosshair ? "on" : "off"} (Alt+C)`}
            onClick={onToggleCrosshair}
          />
        </ToolbarGroup>

        {isLoadingKlines && (
          <span className="flex items-center gap-1.5 text-2xs text-terminal-info whitespace-nowrap" role="status">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-info animate-pulse" />
            Loading
          </span>
        )}
      </div>

      {/* ── Centre: market data (shrinks / hides first on narrow screens) ── */}
      <div className="flex items-center justify-center gap-2 min-w-0 overflow-hidden">
        <LiveQuote />
        <OrderFlowBadge />
      </div>

      {/* ── Right: chart layers · panels · system ─────────────────────── */}
      <div className="flex items-center gap-2 shrink-0">
        <ToolbarGroup label="Chart layers">
          {LAYER_META.map((l) => {
            const na = layerUnavailable[l.key];
            return (
              <ToolbarButton
                key={l.key}
                icon={l.icon}
                label={l.label}
                collapseLabel
                active={!na && layers[l.key]}
                disabled={!!na}
                tone={l.tone}
                title={na ? `${l.description} — unavailable: ${na}` : `${l.description} — ${layers[l.key] ? "on" : "off"}`}
                onClick={() => onToggleLayer(l.key)}
              />
            );
          })}
          <ToolbarDivider className="mx-0.5 !h-4" />
          <HeatmapFadeMenu
            heatmapEnabled={layers.heatmap && !layerUnavailable.heatmap}
            heatmapFade={heatmapFade}
            fadeStrength={fadeStrength}
            showMenu={showFadeMenu}
            onToggleMenu={onToggleFadeMenu}
            onCloseMenu={onCloseFadeMenu}
            onToggleFade={onToggleHeatmapFade}
            onChangeStrength={onChangeFadeStrength}
          />
        </ToolbarGroup>

        <ToolbarGroup label="Panels">
          <ToolbarButton
            icon="signals"
            label="Signals"
            collapseLabel
            active={showSignals}
            tone="gold"
            title="v7.4 institutional signals panel"
            onClick={onToggleSignals}
          />
          <ToolbarButton
            icon="dom"
            label="DOM"
            collapseLabel
            active={showDomLadder}
            tone="info"
            title="L2 order book ladder (Alt+D)"
            onClick={onToggleDomLadder}
          />
          <ToolbarButton
            icon="flow"
            label="Flow"
            collapseLabel
            active={showOrderFlow}
            tone="bull"
            title="Order flow · bubble regime panel (OI + liquidation sweeps)"
            onClick={onToggleOrderFlow}
          />
          <ToolbarButton
            icon="diags"
            label="Diags"
            collapseLabel
            active={showDiagnostics}
            tone="accent"
            title="Diagnostics & telemetry panel"
            onClick={onToggleDiagnostics}
          />
        </ToolbarGroup>

        <ToolbarGroup label="System">
          <ChartStyleMenu
            style={chartStyle}
            open={showStyleMenu}
            onToggle={onToggleStyleMenu}
            onClose={onCloseStyleMenu}
            onChange={onChangeChartStyle}
          />
          <ToolbarButton
            icon={soundOn ? "bell" : "bellOff"}
            active={soundOn}
            tone="gold"
            title={soundOn ? "Mute A+ alert sound" : "Unmute A+ alert sound"}
            onClick={onToggleSound}
          />
          <ToolbarButton
            icon="theme"
            title={`Theme: ${theme} (click to cycle)`}
            onClick={onCycleTheme}
          >
            <span className="hidden xl:inline uppercase">{theme}</span>
          </ToolbarButton>
          <div
            className={`flex items-center gap-1.5 h-7 px-2 text-2xs font-semibold whitespace-nowrap ${conn.text}`}
            role="status"
            title={`Bridge connection: ${conn.label}`}
          >
            <span className={`w-2 h-2 rounded-full ${conn.dot}`} aria-hidden="true" />
            <span className="hidden lg:inline uppercase tracking-wide">{conn.label}</span>
          </div>
        </ToolbarGroup>
      </div>
    </header>
  );
});
