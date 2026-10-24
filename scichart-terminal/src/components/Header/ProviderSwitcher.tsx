import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  getSharedSocket,
  DEFAULT_BRIDGE_URL,
  type ProviderOption,
} from "../../hooks/useLiveOrderBook";
import { useVenue } from "../../hooks/useVenue";
import { Icon } from "./Icon";

interface ProvidersReply {
  type: "providers";
  active: string;
  providers: ProviderOption[];
}
interface SwitchReply {
  type: "provider_switch";
  ok: boolean;
  restarting?: boolean;
  error?: string;
}

const CAP_LABELS: Array<[keyof ProviderOption["capabilities"], string]> = [
  ["l2_depth", "L2 depth"],
  ["trades", "Trade tape"],
  ["open_interest", "Open interest"],
  ["liquidations", "Liquidations"],
];

/** Instrument chip + market-data provider switcher (Binance ⇄ OANDA).
 *
 *  The switch is executed by the bridge (persist + restart), so this only sends the
 *  request and shows progress. The chart resets itself when the next frame reports
 *  a different venue (see App.tsx), so no reload is needed. */
export const ProviderSwitcher = memo(function ProviderSwitcher({
  onNotify,
}: {
  onNotify: (msg: string, type?: "info" | "bull" | "bear") => void;
}) {
  const venue = useVenue();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside click closes (listener only while open).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Refresh the provider list each time the menu opens (credentials may have changed).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    getSharedSocket(DEFAULT_BRIDGE_URL)
      .request<ProvidersReply>("get_providers", {}, 5000)
      .then((r) => alive && setProviders(r.providers))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [open]);

  // Clear the "switching" state once the bridge reports the requested venue.
  useEffect(() => {
    if (busy && venue.name === busy) {
      setBusy(null);
      onNotify(`Market data: ${venue.label} · ${venue.display_symbol}`, "info");
    }
  }, [busy, venue.name, venue.label, venue.display_symbol, onNotify]);

  const select = useCallback(
    async (p: ProviderOption) => {
      if (!p.available || p.name === venue.name || busy) return;
      setBusy(p.name);
      setError(null);
      try {
        const r = await getSharedSocket(DEFAULT_BRIDGE_URL).request<SwitchReply>(
          "set_provider",
          { provider: p.name },
          8000,
        );
        if (!r.ok) throw new Error(r.error || "switch rejected");
        if (!r.restarting) setBusy(null);
        setOpen(false);
      } catch (e) {
        setBusy(null);
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        onNotify(`Provider switch failed: ${msg}`, "bear");
      }
    },
    [venue.name, busy, onNotify],
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${venue.label} · click to change market-data provider`}
        className="flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-lg bg-terminal-panel border border-terminal-border hover:border-terminal-gold/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-accent/70"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${busy ? "bg-terminal-warn animate-pulse" : "bg-terminal-gold"}`}
          aria-hidden="true"
        />
        <span className="font-bold tracking-wider text-[13px] text-terminal-text">
          {venue.display_symbol}
        </span>
        <span className="hidden sm:inline text-2xs px-1.5 rounded bg-terminal-surface border border-terminal-border text-terminal-text-dim font-semibold">
          {venue.contract}
        </span>
        <span className="hidden md:inline text-2xs text-terminal-text-dim uppercase">
          {busy ? "switching…" : venue.name}
        </span>
        <Icon name="chevron" className="w-3 h-3 text-terminal-text-dim" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Market-data provider"
          className="absolute top-full mt-2 left-0 z-50 w-80 p-2 rounded-lg bg-terminal-surface border border-terminal-border shadow-2xl text-2xs font-mono space-y-1.5"
        >
          <div className="px-1 pb-1 border-b border-terminal-border/60 font-bold text-terminal-gold">
            MARKET-DATA PROVIDER
          </div>
          {!providers && !error && <div className="px-1 py-2 text-terminal-text-dim">Loading…</div>}
          {providers?.map((p) => {
            const active = p.name === venue.name;
            return (
              <button
                key={p.name}
                type="button"
                role="option"
                aria-selected={active}
                disabled={!p.available || !!busy}
                onClick={() => select(p)}
                title={p.reason ?? undefined}
                className={`w-full text-left p-2 rounded-md border transition-colors disabled:cursor-not-allowed ${
                  active
                    ? "border-terminal-gold/60 bg-terminal-gold/10"
                    : "border-terminal-border hover:border-terminal-text-dim"
                } ${!p.available ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-terminal-text">
                    {p.label} · {p.display_symbol}
                  </span>
                  <span className="text-terminal-text-dim">{active ? "ACTIVE" : p.contract}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                  {CAP_LABELS.map(([k, label]) => (
                    <span key={k} className={p.capabilities[k] ? "text-terminal-bull" : "text-terminal-text-dim line-through"}>
                      {label}
                    </span>
                  ))}
                  <span className="text-terminal-text-dim">
                    vol: {p.capabilities.volume === "tick" ? "tick count" : "traded"}
                  </span>
                </div>
                {!p.available && p.reason && <div className="mt-1 text-terminal-warn">{p.reason}</div>}
              </button>
            );
          })}
          {error && <div className="px-1 text-terminal-bear">{error}</div>}
          <p className="px-1 pt-1 text-terminal-text-dim leading-snug">
            Switching restarts the bridge (~5 s). Each provider keeps its own signal ledger and
            risk settings; layers whose data the provider lacks are disabled.
          </p>
        </div>
      )}
    </div>
  );
});
