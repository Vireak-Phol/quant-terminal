import { forwardRef, memo, useImperativeHandle, useRef } from "react";
import type { CandleReadout } from "../../chart/TerminalChart";
import { compact, price, signed, signedPct } from "../../lib/format";

export interface CrosshairLegendHandle {
  /** Imperative update — called from the chart's pointer listener / frame pump, so
   *  hovering never re-renders React. */
  update(r: CandleReadout | null): void;
}

interface Props {
  /** "tick" on quote-only venues (OANDA): volume is a quote-change count. */
  volumeKind: "exchange" | "tick";
  /** "tick_rule" on OANDA: no exchange delta exists, so the Δ field is hidden. */
  deltaKind: "exchange" | "tick_rule";
}

const FIELDS = ["time", "o", "h", "l", "c", "chg", "vol", "delta", "cursor"] as const;
type Field = (typeof FIELDS)[number];

function fmtTime(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** TradingView-style OHLC legend in the chart's top-left corner. Shows the candle
 *  under the crosshair, or the live candle when the pointer is off the plot. */
export const CrosshairLegend = memo(
  forwardRef<CrosshairLegendHandle, Props>(function CrosshairLegend({ volumeKind, deltaKind }, ref) {
    const root = useRef<HTMLDivElement | null>(null);
    const els = useRef<Partial<Record<Field, HTMLSpanElement | null>>>({});
    const last = useRef<string>("");

    useImperativeHandle(
      ref,
      () => ({
        update(r) {
          const el = root.current;
          if (!el) return;
          if (!r) {
            el.style.visibility = "hidden";
            return;
          }
          el.style.visibility = "visible";
          const up = r.close >= r.open;
          const chg = r.open ? ((r.close - r.open) / r.open) * 100 : 0;
          const vals: Record<Field, string> = {
            time: `${fmtTime(r.time)}${r.live ? " · live" : ""}`,
            o: price(r.open, 2),
            h: price(r.high, 2),
            l: price(r.low, 2),
            c: price(r.close, 2),
            chg: `${signed(r.close - r.open, 2)} (${signedPct(chg, 2)})`,
            vol: r.volume == null ? "—" : compact(r.volume, 1),
            delta: r.delta == null ? "—" : signed(r.delta, 1),
            cursor: r.cursorPrice == null ? "" : price(r.cursorPrice, 2),
          };
          // Skip DOM writes when nothing visible changed (pointer moving inside one candle).
          const key = FIELDS.map((f) => vals[f]).join("|") + up;
          if (key === last.current) return;
          last.current = key;
          for (const f of FIELDS) {
            const s = els.current[f];
            if (s) s.textContent = vals[f];
          }
          const tone = up ? "var(--legend-up, #26a69a)" : "var(--legend-down, #ef5350)";
          for (const f of ["o", "h", "l", "c", "chg"] as const) {
            const s = els.current[f];
            if (s) s.style.color = tone;
          }
          const dEl = els.current.delta;
          if (dEl) {
            dEl.style.color =
              r.delta == null
                ? ""
                : r.delta >= 0
                  ? "var(--legend-up, #26a69a)"
                  : "var(--legend-down, #ef5350)";
          }
          const cur = els.current.cursor?.parentElement;
          if (cur) cur.style.display = r.cursorPrice == null ? "none" : "";
        },
      }),
      [],
    );

    const bind = (f: Field) => (n: HTMLSpanElement | null) => {
      els.current[f] = n;
    };

    return (
      <div
        ref={root}
        aria-live="off"
        className="pointer-events-none absolute top-2 left-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1 rounded-md bg-terminal-bg/70 backdrop-blur-sm border border-terminal-border/50 font-mono text-2xs tabular-nums text-terminal-text-dim"
        style={{ visibility: "hidden" }}
      >
        <span ref={bind("time")} className="text-terminal-text" />
        <span>O <span ref={bind("o")} /></span>
        <span>H <span ref={bind("h")} /></span>
        <span>L <span ref={bind("l")} /></span>
        <span>C <span ref={bind("c")} /></span>
        <span ref={bind("chg")} />
        <span title={volumeKind === "tick" ? "Tick volume: number of quote changes (OANDA has no traded volume)" : "Traded volume"}>
          {volumeKind === "tick" ? "Ticks" : "Vol"} <span ref={bind("vol")} className="text-terminal-text" />
        </span>
        {deltaKind === "exchange" && (
          <span title="Aggressor delta: taker buy − taker sell">
            Δ <span ref={bind("delta")} />
          </span>
        )}
        <span style={{ display: "none" }}>
          ⌖ <span ref={bind("cursor")} className="text-terminal-gold" />
        </span>
      </div>
    );
  }),
);
