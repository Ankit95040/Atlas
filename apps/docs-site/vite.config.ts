import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset base: the built site works from any deployment path
  // (repository project pages such as /Atlas/, a custom domain, or local
  // preview) with zero config changes. Hash routing is path-independent.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5175,
  },
});
