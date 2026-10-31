import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:3001" },
    watch: {
      ignored: ["**/.data/**", "**/test-results/**", "**/playwright-report/**"],
    },
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/.data/**"],
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
} as any);
