import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // dev-only: lets a profiled sitting use the JS Self-Profiling API
    // (new Profiler(...)) against the live app; absent from any build output
    headers: { "Document-Policy": "js-profiling" },
  },
});
