import { useEffect, useRef, useState } from "react";
import type { BookmapFrame } from "../types/frame";

export type ConnStatus = "connecting" | "open" | "closed";

const DEFAULT_URL = "ws://localhost:8765";

/**
 * Subscribes to the orderbook-bridge WebSocket and returns the latest
 * `bookmap_update` frame plus connection status. Auto-reconnects with backoff.
 *
 * The bridge omits the heavy `v74` key on unchanged frames and only sends partial
 * updates for some keys; this hook MERGES each incoming frame onto the previous
 * one so the UI always has a complete picture (matching the bridge's broadcast
 * optimization in bridge.py).
 */
export function useBridge(url: string = DEFAULT_URL) {
  const [frame, setFrame] = useState<BookmapFrame | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const frameRef = useRef<BookmapFrame | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    closedRef.current = false;

    const connect = () => {
      if (closedRef.current) return;
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setStatus("open");
      };

      ws.onmessage = (ev) => {
        try {
          const partial = JSON.parse(ev.data as string) as Partial<BookmapFrame> & {
            type?: string;
          };
          if (partial.type && partial.type !== "bookmap_update") return;
          const merged = { ...(frameRef.current ?? {}), ...partial } as BookmapFrame;
          frameRef.current = merged;
          setFrame(merged);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        setStatus("closed");
        if (closedRef.current) return;
        const delay = Math.min(1000 * 2 ** retryRef.current, 8000);
        retryRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [url]);

  return { frame, status };
}
