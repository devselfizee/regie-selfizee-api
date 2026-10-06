// Géocodage d'adresses françaises par la Géoplateforme (Base Adresse Nationale, IGN) :
// service public, gratuit, sans clé. Sert à placer les lieux sur la carte.

export interface Position {
  latitude: number;
  longitude: number;
  libelle: string;
  score: number;
}

const URL_GEOCODAGE = "https://data.geopf.fr/geocodage/search";

/** Position d'une adresse, ou null si introuvable / trop incertaine / service indisponible. */
export async function geocoder(adresse: { adresse?: string | null; codePostal?: string | null; ville?: string | null }): Promise<Position | null> {
  const q = [adresse.adresse, adresse.codePostal, adresse.ville].filter(Boolean).join(" ").trim();
  if (q.length < 3) return null;
  try {
    const params = new URLSearchParams({ q, limit: "1" });
    if (adresse.codePostal) params.set("postcode", adresse.codePostal);
    // Sans rue, on ne cherche que des communes : « La Baule » seul trouverait sinon une
    // rue de ce nom dans le Lot avant la commune de La Baule-Escoublac.
    if (!adresse.adresse?.trim()) params.set("type", "municipality");
    const appeler = () => fetch(`${URL_GEOCODAGE}?${params}`, { signal: AbortSignal.timeout(5000) });
    // Une seconde tentative en cas de coupure réseau ponctuelle
    const res = await appeler().catch(() => appeler());
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: { geometry: { coordinates: [number, number] }; properties: { label: string; score: number } }[];
    };
    const f = json.features?.[0];
    if (!f || f.properties.score < 0.4) return null;
    const [longitude, latitude] = f.geometry.coordinates;
    return { latitude, longitude, libelle: f.properties.label, score: f.properties.score };
  } catch {
    return null; // le géocodage ne doit jamais empêcher d'enregistrer une fiche
  }
}
