import { SciChartSurface } from "scichart";

// Personal / non-commercial use => SciChart free Community Edition.
// No license key required; a small watermark is shown (acceptable for a personal
// terminal). To remove the watermark later, call SciChartSurface.setRuntimeLicenseKey(...)
// with a purchased commercial key.
//
// WASM loading strategy: try local files (copied into the served root by
// vite-plugin-static-copy) for fully-offline operation; if that fails at runtime
// SciChart automatically surfaces an error, in which case switch to useWasmFromCDN().
let configured = false;

export function configureSciChart() {
  if (configured) return;
  configured = true;
  try {
    SciChartSurface.useWasmLocal();
  } catch {
    SciChartSurface.useWasmFromCDN();
  }
}
