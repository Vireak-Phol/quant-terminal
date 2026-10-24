import { memo, useEffect, useId, useRef } from "react";
import {
  DEFAULT_CHART_STYLE,
  STYLE_PRESETS,
  bubblePaint,
  type ChartStyle,
} from "../../lib/chartStyle";
import { Icon } from "./Icon";

export interface ChartStyleMenuProps {
  style: ChartStyle;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (next: ChartStyle) => void;
}

type ColorKey = Exclude<keyof ChartStyle, "bubbleOpacity">;

const CANDLE_FIELDS: Array<[ColorKey, string]> = [
  ["candleUpBody", "Up body"],
  ["candleDownBody", "Down body"],
  ["candleUpWick", "Up wick / outline"],
  ["candleDownWick", "Down wick / outline"],
];
const BUBBLE_FIELDS: Array<[ColorKey, string]> = [
  ["bubbleBuy", "Buyers absorbed"],
  ["bubbleSell", "Sellers absorbed"],
  ["bubbleText", "Number text"],
];

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id} className="text-terminal-text-dim">
        {label}
      </label>
      <span className="flex items-center gap-1.5">
        <span className="tabular-nums text-terminal-text-dim uppercase">{value}</span>
        <input
          id={id}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-7 h-5 p-0 border border-terminal-border rounded cursor-pointer bg-transparent"
        />
      </span>
    </div>
  );
}

/** Candle + absorption-bubble colour settings. Changes apply live and persist.
 *  Fully controlled (state in App), like HeatmapFadeMenu. */
export const ChartStyleMenu = memo(function ChartStyleMenu({
  style,
  open,
  onToggle,
  onClose,
  onChange,
}: ChartStyleMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const set = (k: ColorKey) => (v: string) => onChange({ ...style, [k]: v.toLowerCase() });
  const preview = (side: "buy" | "sell", battle: boolean) => {
    const p = bubblePaint(style, side, battle);
    return { background: p.fill, borderColor: p.stroke, borderWidth: p.strokeThickness, color: style.bubbleText };
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Chart colours: candles & bubbles"
        aria-label="Chart colours"
        className={`inline-flex items-center justify-center h-7 px-2 rounded-md text-2xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-accent/70 ${
          open ? "text-terminal-gold" : "text-terminal-text-dim hover:text-terminal-text hover:bg-terminal-text/5"
        }`}
      >
        <Icon name="palette" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Chart colours"
          className="absolute top-full mt-2 right-0 z-50 w-80 p-3 rounded-lg bg-terminal-surface border border-terminal-border shadow-2xl text-2xs font-mono space-y-3"
        >
          <div className="flex items-center justify-between border-b border-terminal-border/60 pb-1.5">
            <span className="font-bold text-terminal-gold flex items-center gap-1.5">
              <Icon name="palette" /> CHART COLOURS
            </span>
            <button onClick={onClose} className="text-terminal-text-dim hover:text-terminal-text" aria-label="Close">
              ✕
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {STYLE_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => onChange({ ...p.style })}
                className="px-2 py-0.5 rounded border border-terminal-border text-terminal-text-dim hover:text-terminal-text hover:border-terminal-text-dim"
              >
                {p.name}
              </button>
            ))}
          </div>

          <section className="space-y-1.5" aria-label="Candles">
            <div className="flex items-center justify-between">
              <span className="font-bold text-terminal-text">Candles</span>
              <span className="flex items-end gap-1 h-5" aria-hidden="true">
                <span className="w-2 h-4 rounded-sm border" style={{ background: style.candleUpBody, borderColor: style.candleUpWick }} />
                <span className="w-2 h-3 rounded-sm border" style={{ background: style.candleDownBody, borderColor: style.candleDownWick }} />
              </span>
            </div>
            {CANDLE_FIELDS.map(([k, label]) => (
              <ColorRow key={k} label={label} value={style[k]} onChange={set(k)} />
            ))}
            <p className="text-terminal-text-dim leading-snug">
              The Delta layer colours bodies with these up/down colours by aggressor delta.
            </p>
          </section>

          <section className="space-y-1.5" aria-label="Absorption bubbles">
            <div className="flex items-center justify-between">
              <span className="font-bold text-terminal-text">Absorption bubbles</span>
              <span className="flex items-center gap-1" aria-hidden="true">
                {(["buy", "sell"] as const).map((side) => (
                  <span key={side} className="flex gap-1">
                    <span className="w-5 h-5 rounded-full border grid place-items-center text-[8px] font-bold" style={preview(side, false)}>87</span>
                    <span className="w-5 h-5 rounded-full border grid place-items-center text-[8px] font-bold" style={preview(side, true)}>B</span>
                  </span>
                ))}
              </span>
            </div>
            {BUBBLE_FIELDS.map(([k, label]) => (
              <ColorRow key={k} label={label} value={style[k]} onChange={set(k)} />
            ))}
            <div className="space-y-0.5">
              <div className="flex items-center justify-between text-terminal-text-dim">
                <label htmlFor="bubble-opacity">Fill opacity</label>
                <span className="tabular-nums text-terminal-text">{Math.round(style.bubbleOpacity * 100)}%</span>
              </div>
              <input
                id="bubble-opacity"
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={style.bubbleOpacity}
                onChange={(e) => onChange({ ...style, bubbleOpacity: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-terminal-panel rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
            </div>
            <p className="text-terminal-text-dim leading-snug">
              "Battle" bubbles (absorbed while open interest rose) use the same hue, near-opaque
              with a light ring.
            </p>
          </section>

          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_CHART_STYLE })}
            className="w-full py-1 rounded border border-terminal-border text-terminal-text-dim hover:text-terminal-text"
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
});
