import { memo } from "react";

/** Toolbar icon set — inline 16×16 stroke SVGs drawn in `currentColor`, so they
 *  inherit the button's text colour and theme. No icon dependency needed. */
export type IconName =
  | "heatmap"
  | "absorb"
  | "vacuum"
  | "hopla"
  | "delta"
  | "fade"
  | "chevron"
  | "signals"
  | "dom"
  | "diags"
  | "flow"
  | "bell"
  | "bellOff"
  | "live"
  | "theme";

const PATHS: Record<IconName, JSX.Element> = {
  heatmap: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" opacity=".55" />
      <rect x="2" y="9" width="5" height="5" rx="1" opacity=".55" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  absorb: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  vacuum: (
    <>
      <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" />
      <path d="M8 5.5a2.5 2.5 0 1 0 2.5 2.5" />
    </>
  ),
  hopla: (
    <>
      <path d="M2 3.5h12" />
      <path d="M2 8h12" strokeDasharray="2 2" />
      <path d="M2 12.5h12" />
    </>
  ),
  delta: <path d="M8 2.5 14 13.5H2Z" />,
  fade: (
    <>
      <path d="M2 4h12" />
      <path d="M2 8h9" opacity=".6" />
      <path d="M2 12h5" opacity=".3" />
    </>
  ),
  chevron: <path d="m4 6 4 4 4-4" />,
  signals: <path d="m8 2 1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.4l-3.7 2.1.8-4.2L2 6.4l4.2-.5Z" />,
  dom: (
    <>
      <path d="M2 3.5h7" />
      <path d="M2 6.5h10" />
      <path d="M2 9.5h12" />
      <path d="M2 12.5h5" />
    </>
  ),
  diags: <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />,
  flow: (
    <>
      <circle cx="5" cy="10" r="3" />
      <circle cx="11" cy="5" r="2.2" />
      <circle cx="12" cy="12" r="1.3" />
    </>
  ),
  bell: (
    <>
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3Z" />
      <path d="M6.5 14a1.5 1.5 0 0 0 3 0" />
    </>
  ),
  bellOff: (
    <>
      <path d="M4 11V7a4 4 0 0 1 6.6-3" />
      <path d="M12 7v4l1 1.5H5.5" />
      <path d="M2 2l12 12" />
    </>
  ),
  live: (
    <>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1" />
      <path d="M12 1.8v2.6H9.4" />
    </>
  ),
  theme: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" stroke="none" />
    </>
  ),
};

export const Icon = memo(function Icon({
  name,
  className = "w-3.5 h-3.5",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
});
