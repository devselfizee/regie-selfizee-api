// Réglages de la synchro PikCloud lus dans l'environnement (voir .env.example).

const HOTES_PAR_DEFAUT = ["api.pikcloud.io", "apidev.pikcloud.io"];

/** Hôtes dont on accepte de télécharger les liens (PIKCLOUD_HOTES_AUTORISES, séparés par des virgules). */
export function hotesAutorises(): string[] {
  const v = process.env.PIKCLOUD_HOTES_AUTORISES?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return v?.length ? v : HOTES_PAR_DEFAUT;
}
