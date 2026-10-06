import "dotenv/config";
import { creerApp } from "./app.js";
import { demarrerPlanificateur } from "./taches.js";
import { initialiserReferentiel } from "./referentiel/initial.js";

const PORT = process.env.PORT || 3003;

// Listes de départ (types de lieux, gammes, modules…) si la base est neuve
await initialiserReferentiel();

creerApp().listen(PORT, () => {
  console.log(`API Régie running on http://localhost:${PORT}`);
  demarrerPlanificateur();
});
