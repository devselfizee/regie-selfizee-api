import { execSync } from "node:child_process";
import "dotenv/config";

// Applique les migrations sur la base de test ; chaque test vide ensuite ses tables.
export default function () {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST non défini (voir .env.example)");
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
