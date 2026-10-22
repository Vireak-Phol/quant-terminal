import { memo } from "react";
import { useLiveField } from "../../hooks/useLiveField";
import { V7SignalPanel } from "../Dashboard/V7SignalPanel";
import type { ChartTf } from "../../types/v74";

const SignalPanelMemo = memo(V7SignalPanel);

/** Self-subscribing signal dock. Owns its own `v74` selector so the panel only
 *  re-renders on closed-bar engine changes, never on the 12-15fps price feed. */
export const SignalDock = memo(function SignalDock(props: {
  tf: ChartTf;
  onTfChange: (tf: ChartTf) => void;
  onClose: () => void;
}) {
  const v74 = useLiveField((s) => s.data?.v74 ?? null);
  return <SignalPanelMemo v74={v74} {...props} />;
});
