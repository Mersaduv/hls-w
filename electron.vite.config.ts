import path from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: path.resolve(__dirname, "src/main/index.ts"),
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
        "@main": path.resolve(__dirname, "src/main"),
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: path.resolve(__dirname, "src/preload/index.ts"),
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: path.resolve(__dirname, "src/renderer/index.html"),
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
        "@renderer": path.resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
