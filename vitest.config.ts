import { defineConfig } from "vitest/config";
import "dotenv/config";

// Les tests utilisent la base DATABASE_URL_TEST (jamais la base de dev)
export default defineConfig({
  test: {
    globalSetup: ["./tests/setup-global.ts"],
    env: { DATABASE_URL: process.env.DATABASE_URL_TEST ?? "", NODE_ENV: "test" },
    fileParallelism: false,
    // Tests d'intégration sur une vraie base : quelques secondes par test sur une machine chargée
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
