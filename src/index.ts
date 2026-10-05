import "dotenv/config";
import { creerApp } from "./app.js";

const PORT = process.env.PORT || 3003;

creerApp().listen(PORT, () => {
  console.log(`API Régie running on http://localhost:${PORT}`);
});
