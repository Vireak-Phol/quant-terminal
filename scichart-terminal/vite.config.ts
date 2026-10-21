import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

// SciChart.js ships a WebAssembly module (scichart2d.wasm) + data file.
// They must be served next to the app bundle. We copy them from node_modules
// into the build output / dev root so SciChartSurface can load them locally
// (no CDN dependency, works fully offline for a personal terminal).
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          // scichart 6.x ships several wasm builds (simd / nosimd / 64).
          // Copy them all to the served root so useWasmFromLocal() resolves.
          src: "node_modules/scichart/_wasm/*.wasm",
          dest: "",
        },
      ],
    }),
  ],
  server: {
    port: 5273,
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy SciChart engine and React into their own vendor chunks
        // so the app chunk stays small and browsers cache the engine separately.
        manualChunks: {
          scichart: ["scichart"],
          react: ["react", "react-dom"],
        },
      },
    },
    // The SciChart WASM/WebGL engine is intrinsically large; after the manual
    // vendor split no app chunk approaches this, so raise the advisory ceiling.
    chunkSizeWarningLimit: 900,
  },
});
