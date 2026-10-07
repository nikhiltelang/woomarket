import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["server/__tests__/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Integration suites share one database; run files sequentially.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      // Unit/HTTP suites never touch a real database.
      DATABASE_URL: "mysql://test:test@127.0.0.1:1/woomarket_test",
      WEBHOOK_VERIFY_TOKEN: "test-verify-token",
      WHATSAPP_APP_SECRET: "test-app-secret",
      ENCRYPTION_KEY: "test-encryption-key",
      SESSION_SECRET: "test-session-secret-that-is-long-enough-1234",
    },
  },
});
