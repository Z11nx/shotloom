import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.PORT || "8787";
const clientPort = Number(process.env.CLIENT_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only, with Vite's default host checking left on.
    host: "127.0.0.1",
    port: clientPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/media": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
