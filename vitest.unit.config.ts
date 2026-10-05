import { defineConfig } from "vitest/config";

// Tests sans base de données
export default defineConfig({ test: { include: ["tests/unitaires.test.ts"] } });
