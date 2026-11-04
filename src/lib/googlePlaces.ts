// Google Places (API « Places API (New) », recherche texte) : retrouve un lieu d'après son nom et son adresse, avec
// son type (bar, night_club, shopping_mall…), sa note et son nombre d'avis. Sert à catégoriser les emplacements des
// concurrents (demande de Sébastien, 04/11/2026). Clé dans GOOGLE_PLACES_API_KEY (variable d'environnement Coolify).

export interface LieuGoogle {
  placeId: string;
  nom: string;
  adresse: string | null;
  typePrincipal: string | null;
  types: string[];
  note: number | null;
  nbAvis: number | null;
  url: string | null;
}

export const googlePlacesConfigure = () => Boolean(process.env.GOOGLE_PLACES_API_KEY);

const CHAMPS = ["places.id", "places.displayName", "places.formattedAddress", "places.primaryType", "places.types", "places.rating", "places.userRatingCount", "places.googleMapsUri"];

/** Premier lieu trouvé pour « nom + adresse » (près de la position connue), null si aucun ; lève une erreur si Google refuse. */
export async function chercherLieuGoogle(l: {
  nom: string;
  adresse?: string | null;
  codePostal?: string | null;
  ville?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): Promise<LieuGoogle | null> {
  const cle = process.env.GOOGLE_PLACES_API_KEY;
  if (!cle) throw new Error("GOOGLE_PLACES_API_KEY absente");
  const corps: Record<string, unknown> = {
    textQuery: [l.nom, l.adresse, l.codePostal, l.ville].filter(Boolean).join(", "),
    languageCode: "fr",
    regionCode: "FR",
    pageSize: 1,
  };
  if (l.latitude != null && l.longitude != null)
    corps.locationBias = { circle: { center: { latitude: l.latitude, longitude: l.longitude }, radius: 500 } };
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": cle, "X-Goog-FieldMask": CHAMPS.join(",") },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google Places ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    places?: {
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      primaryType?: string;
      types?: string[];
      rating?: number;
      userRatingCount?: number;
      googleMapsUri?: string;
    }[];
  };
  const p = json.places?.[0];
  if (!p) return null;
  return {
    placeId: p.id,
    nom: p.displayName?.text ?? l.nom,
    adresse: p.formattedAddress ?? null,
    typePrincipal: p.primaryType ?? null,
    types: p.types ?? [],
    note: p.rating ?? null,
    nbAvis: p.userRatingCount ?? null,
    url: p.googleMapsUri ?? null,
  };
}
