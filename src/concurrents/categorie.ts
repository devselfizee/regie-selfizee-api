// Catégorie probable d'un emplacement de concurrent d'après son nom (demande de Sébastien, 03/11/2026) : une
// première passe, corrigée ensuite à la main dans la liste. Renvoie le code TYPE_LIEU, ou null si rien ne ressort.
// L'ordre compte : « Forum des Halles » est un centre commercial avant d'être une halle, « Moon Social Club » un club.

const REGLES: [code: string, motifs: RegExp][] = [
  ["CINEMA", /\b(cgr|cinema|pathe|ugc|kinepolis|megarama)\b/],
  ["BOWLING", /\b(bowling|bowldog)\b/],
  ["CAMPING", /\bcamping\b/],
  ["HOTEL", /\b(hotel|moxy|ibis|novotel|mama shelter)\b/],
  [
    "CENTRE_COMMERCIAL",
    /\b(centre commercial|centre deux|westfield|klepierre|apsys|nhood|mercialys|ingka|scc|phalsbourg|euralille|parly 2|velizy 2|rosny 2|creteil soleil|forum des halles|les 4 temps|carre senart|polygone|odysseum|aeroville|confluence|beaugrenelle|carrousel du louvre|galerie|shopping|outlet|grand plaisir|la vallee|les sentiers|passage du havre|toison d'or|kirchberg|cloche d'or|merlata|village made in france|samaritaine|hyper u|shop park|grand a|les belles aires)\b/,
  ],
  [
    "FOOD_COURT",
    /\b(halles?|food (court|hall)|friche gourmande|lafrichegourmande|biltoki|marche|eataly|darwin|markthalle|mercado|felicita|centr'halles|dij'eat|entrepot|feel good market|gruppomimo|cuvette des bouillons|maillerie)\b/,
  ],
  ["SALLE_SPECTACLE", /\b(zenith|olympia|transbordeur|glazart|bellevilloise|centquatre|cabaret|chapiteau|salle de concert|theatre|expo|dock b|la cigale|bataclan)\b/],
  ["LIEU_TOURISTIQUE", /\b(musee|grevin|frac|chateau|aquarium)\b/],
  ["PARC_LOISIRS", /\b(escape|panic room|climbing|escalade|laser|karting|foire|trampoline|hasard ludique|shuffled|red factory|quai de la photo)\b/],
  [
    "BOITE_DE_NUIT",
    /\b(club|discotheque|night ?club|coco bongo|badaboum|noct|dancing|kodz|heat|bunker|retro club|le sucre|le rex|steel|punk paradise|le gotha|virage|dock|l'atoll|azar)\b/,
  ],
  [
    "BAR",
    /\b(bar|pub|cafe|biere|bierotheque|brew(pub|ery)?|beer|delirium|levrette|o'sullivans|ninkasi|guinguette|saloon|rooftop|zinc|troquet|berlin 1989|brique|chupitos|rhum|cocktails?|tapas|buvette|bodega|comptoir|tavern|taverne|brasseurs|mac carthy|james joyce|o'green|piraat|kneckes|barrel|helter skelter|liebe|rosa bonheur|wanderlust|chaud bouillon|monsieur le zinc|beer bretzel|black lion|elephant|wall street|french house|fitzroy|badass|austra rocks|prohibition|meteor|v and b|bien public|bien boire|troquetdeskneckes|recyclerie|cite fertile|comptoir general|rotonde)\b/,
  ],
  ["RESTAURANT", /\b(restaurant|brasserie|bistrot|bistro|cantine|kitchen|doppio malto|bouillon|pizzeria|trattoria|gamelle|creperie|burger|popolare|carmine|splendido|edmondo|moma|la boca|tomate blanche)\b/],
];

/** Minuscules sans accents, apostrophes droites, « _ » comme espace (« Westfield_Parly 2 ») */
const normaliser = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’`]/g, "'").replace(/_/g, " ").toLowerCase();

// Types Google Places → code TYPE_LIEU. Le type principal est essayé d'abord, puis les autres types du lieu.
const TYPES_GOOGLE: Record<string, string> = {
  bar: "BAR", pub: "BAR", wine_bar: "BAR", cocktail_bar: "BAR", sports_bar: "BAR", irish_pub: "BAR", beer_garden: "BAR", brewpub: "BAR",
  lounge_bar: "BAR", brewery: "BAR", bar_and_grill: "BAR", cafe: "BAR", coffee_shop: "BAR",
  night_club: "BOITE_DE_NUIT", dance_hall: "BOITE_DE_NUIT", karaoke: "BOITE_DE_NUIT",
  shopping_mall: "CENTRE_COMMERCIAL", department_store: "CENTRE_COMMERCIAL", outlet_mall: "CENTRE_COMMERCIAL", hypermarket: "CENTRE_COMMERCIAL",
  food_court: "FOOD_COURT", market: "FOOD_COURT", farmers_market: "FOOD_COURT",
  movie_theater: "CINEMA",
  bowling_alley: "BOWLING",
  campground: "CAMPING", rv_park: "CAMPING",
  hotel: "HOTEL", lodging: "HOTEL", resort_hotel: "HOTEL", motel: "HOTEL", hostel: "HOTEL",
  concert_hall: "SALLE_SPECTACLE", performing_arts_theater: "SALLE_SPECTACLE", event_venue: "SALLE_SPECTACLE", amphitheatre: "SALLE_SPECTACLE",
  comedy_club: "SALLE_SPECTACLE", live_music_venue: "SALLE_SPECTACLE", auditorium: "SALLE_SPECTACLE", convention_center: "SALLE_SPECTACLE",
  amusement_park: "PARC_LOISIRS", amusement_center: "PARC_LOISIRS", water_park: "PARC_LOISIRS", escape_room: "PARC_LOISIRS",
  go_karting_venue: "PARC_LOISIRS", video_arcade: "PARC_LOISIRS", adventure_sports_center: "PARC_LOISIRS", sports_complex: "PARC_LOISIRS",
  museum: "LIEU_TOURISTIQUE", tourist_attraction: "LIEU_TOURISTIQUE", historical_landmark: "LIEU_TOURISTIQUE", art_gallery: "LIEU_TOURISTIQUE",
  zoo: "LIEU_TOURISTIQUE", aquarium: "LIEU_TOURISTIQUE",
};

/** Catégorie d'après les types Google Places (« bar », « night_club », « *_restaurant »…), null si aucun ne parle */
export function categorieGoogle(typePrincipal: string | null, types: string[]): string | null {
  for (const t of [typePrincipal, ...types]) {
    if (!t) continue;
    if (TYPES_GOOGLE[t]) return TYPES_GOOGLE[t];
    if (t === "restaurant" || t.endsWith("_restaurant") || t === "brasserie" || t === "bistro") return "RESTAURANT";
  }
  return null;
}

export function devinerCategorie(nom: string): string | null {
  const n = normaliser(nom);
  return REGLES.find(([, motif]) => motif.test(n))?.[0] ?? null;
}
