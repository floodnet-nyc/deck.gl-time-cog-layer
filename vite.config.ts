import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "demo-dist",
    target: "esnext",
  },
  worker: {
    format: "es",
  },
});
