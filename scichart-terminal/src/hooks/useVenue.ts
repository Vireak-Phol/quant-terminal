import { useLiveField } from "./useLiveField";
import { DEFAULT_VENUE, type VenueInfo } from "./useLiveOrderBook";

/** Active market-data venue from the bridge frame. Re-renders only when the venue
 *  (name/symbol) changes, never on per-tick frames. */
export function useVenue(): VenueInfo {
  return useLiveField(
    (s) => s.data?.venue ?? DEFAULT_VENUE,
    (a, b) => a.name === b.name && a.symbol === b.symbol,
  );
}
