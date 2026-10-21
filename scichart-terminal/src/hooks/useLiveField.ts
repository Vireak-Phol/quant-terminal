import { useSyncExternalStore, useRef } from "react";
import {
  getSharedSocket,
  DEFAULT_BRIDGE_URL,
  type LiveOrderBookData,
  type ConnectionState,
} from "./useLiveOrderBook";

interface Snapshot {
  data: LiveOrderBookData | null;
  connectionState: ConnectionState;
  latencyMs: number;
}

/**
 * Subscribe to a *slice* of the shared live snapshot. The component only
 * re-renders when the selected value changes (by the provided equality fn,
 * default Object.is), instead of on every 12-15fps websocket frame. This keeps
 * high-frequency fields (mid price, spread) from forcing a full-tree reconcile.
 */
export function useLiveField<T>(
  selector: (snap: Snapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  url = DEFAULT_BRIDGE_URL,
): T {
  const socket = getSharedSocket(url);
  const lastRef = useRef<{ value: T } | null>(null);

  const getSelected = (): T => {
    const next = selector(socket.getSnapshot() as Snapshot);
    const prev = lastRef.current;
    // Memoise so useSyncExternalStore sees a stable reference when the slice is
    // unchanged, preventing a re-render on frames that did not touch this field.
    if (prev && isEqual(prev.value, next)) return prev.value;
    lastRef.current = { value: next };
    return next;
  };

  return useSyncExternalStore(socket.subscribe, getSelected, getSelected);
}
