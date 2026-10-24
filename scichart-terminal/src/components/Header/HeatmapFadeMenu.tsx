import { memo, useEffect, useRef } from "react";
import { Icon } from "./Icon";

export interface HeatmapFadeMenuProps {
  heatmapEnabled: boolean;
  heatmapFade: boolean;
  fadeStrength: number;
  showMenu: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onToggleFade: () => void;
  onChangeStrength: (strength: number) => void;
}

/** BookMap heatmap historical-fade control: a split button + a dropdown panel.
 *  Fully controlled by the parent (state lives in App) so it stays a pure render
 *  given props; it owns only the click-outside listener for its own dropdown. */
export const HeatmapFadeMenu = memo(function HeatmapFadeMenu({
  heatmapEnabled,
  heatmapFade,
  fadeStrength,
  showMenu,
  onToggleMenu,
  onCloseMenu,
  onToggleFade,
  onChangeStrength,
}: HeatmapFadeMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on an outside click. Listener is attached only while the
  // menu is open and torn down when it closes or the component unmounts — no
  // dangling window listener (memory-leak safe).
  useEffect(() => {
    if (!showMenu) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseMenu();
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [showMenu, onCloseMenu]);

  return (
    <div className="relative flex items-center" ref={menuRef}>
      <div
        className={`flex items-center h-7 rounded-md transition-colors ${
          heatmapFade && heatmapEnabled
            ? "ring-1 ring-inset bg-terminal-info/15 text-terminal-info ring-terminal-info/40"
            : "text-terminal-text-dim"
        } ${!heatmapEnabled ? "opacity-35" : ""}`}
      >
        <button
          type="button"
          onClick={onToggleFade}
          aria-pressed={heatmapFade}
          disabled={!heatmapEnabled}
          className="inline-flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-l-md text-2xs font-semibold tracking-wide whitespace-nowrap hover:text-terminal-text disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-accent/70"
          title={
            heatmapEnabled
              ? `Heatmap time-decay fade — ${heatmapFade ? `on (${Math.round(fadeStrength * 100)}%)` : "off"}`
              : "Enable the Heatmap layer first"
          }
        >
          <Icon name="fade" />
          <span className="hidden min-[2000px]:inline">Fade</span>
          {heatmapFade && heatmapEnabled && (
            <span className="hidden min-[2000px]:inline tabular-nums opacity-80">
              {Math.round(fadeStrength * 100)}%
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onToggleMenu}
          disabled={!heatmapEnabled}
          aria-expanded={showMenu}
          aria-haspopup="dialog"
          className={`inline-flex items-center h-7 px-1 rounded-r-md border-l border-terminal-border/60 hover:text-terminal-text hover:bg-terminal-text/5 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-accent/70 ${
            showMenu ? "text-terminal-gold" : ""
          }`}
          title="Heatmap fade settings"
          aria-label="Heatmap fade settings"
        >
          <Icon name="chevron" className="w-3 h-3" />
        </button>
      </div>

      {showMenu && heatmapEnabled && (
        <div className="absolute top-full mt-2 right-0 z-50 w-72 p-3 rounded-lg bg-terminal-surface border border-terminal-border shadow-2xl text-2xs font-mono space-y-2.5">
          <div className="flex items-center justify-between border-b border-terminal-border/60 pb-1.5">
            <span className="font-bold text-terminal-gold flex items-center gap-1.5">
              <Icon name="heatmap" /> HEATMAP FADE
            </span>
            <button
              onClick={onCloseMenu}
              className="text-terminal-text-dim hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-terminal-text-dim">Time-Decay Fade</span>
            <button
              onClick={onToggleFade}
              className={`px-2 py-0.5 rounded text-2xs font-bold transition-all ${
                heatmapFade
                  ? "bg-terminal-bull/20 text-terminal-bull border border-terminal-bull/40"
                  : "bg-terminal-panel text-terminal-text-dim border border-terminal-border"
              }`}
            >
              {heatmapFade ? "ACTIVE" : "OFF"}
            </button>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-terminal-text-dim">
              <span>Fade Decay Strength</span>
              <span className="font-bold tabular-nums text-terminal-text">
                {Math.round(fadeStrength * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0.10"
              max="0.95"
              step="0.05"
              value={fadeStrength}
              onChange={(e) => onChangeStrength(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-terminal-panel rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <div className="flex justify-between text-2xs text-terminal-text-dim">
              <span>Subtle (10%)</span>
              <span>Balanced (70%)</span>
              <span>Steep (95%)</span>
            </div>
          </div>

          <div className="p-1.5 rounded bg-terminal-panel/80 border border-terminal-border/60 text-2xs text-terminal-text-dim space-y-1">
            <div className="flex items-center justify-between text-terminal-text">
              <span>Palette</span>
              <span className="text-terminal-gold font-bold">
                BookMap High-Contrast
              </span>
            </div>
            <div className="h-2 rounded flex overflow-hidden border border-black/40">
              <div className="flex-1 bg-[#05182e]" title="Deep Navy" />
              <div className="flex-1 bg-[#00b4d8]" title="Cyan" />
              <div className="flex-1 bg-[#10b981]" title="Lime" />
              <div className="flex-1 bg-[#facc15]" title="Yellow" />
              <div className="flex-1 bg-[#f97316]" title="Orange" />
              <div className="flex-1 bg-[#ef4444]" title="Red" />
              <div className="flex-1 bg-[#ffffff]" title="Hot White" />
            </div>
            <p className="leading-tight pt-0.5">
              Older liquidity dims smoothly into the canvas; the active front
              displays at full intensity.
            </p>
          </div>
        </div>
      )}
    </div>
  );
});
