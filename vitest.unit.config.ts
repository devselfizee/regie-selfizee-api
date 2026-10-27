import { defineConfig } from "vitest/config";

// Tests sans base de données
export default defineConfig({ test: { testTimeout: 20_000, include: ["tests/unitaires.test.ts", "tests/commissions.test.ts", "tests/meteo.test.ts", "tests/config-evenement.test.ts", "tests/mes-photos.test.ts", "tests/cadres-evenement.test.ts", "tests/parcours-schema.test.ts", "tests/composition-cadres.test.ts"] } });
