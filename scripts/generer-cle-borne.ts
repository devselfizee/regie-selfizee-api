// Génère (ou régénère) la clé API d'une borne. L'ancienne clé cesse de fonctionner.
// Usage : npm run borne:cle -- MT-0042
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { genererCle } from "../src/lib/cleBorne.js";

const identifiant = process.argv[2];
if (!identifiant) {
  console.error("Usage : npm run borne:cle -- <identifiant borne>");
  process.exit(1);
}

const cle = genererCle();
const borne = await prisma.borne.update({
  where: { identifiant },
  data: { apiKeyHash: cle.hash, apiKeyPrefix: cle.prefixe, apiKeyCreeLe: new Date() },
});
console.log(`Nouvelle clé pour ${borne.identifiant} (à copier maintenant, elle n'est pas conservée) :\n${cle.cle}`);
await prisma.$disconnect();
