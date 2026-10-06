// Lecture d'un relevé de prestataire monétique au format CSV (CDC §4 : rapprochement).
// Format générique : faute de spécification Ingenico, l'utilisateur indique quelle
// colonne porte la date, le montant, la référence et le terminal.
import { TZDate } from "@date-fns/tz";
import { FUSEAU_METIER } from "../lib/temps.js";

export interface Csv {
  separateur: string;
  entetes: string[];
  lignes: string[][];
}

/** Séparateur le plus fréquent de la première ligne (hors guillemets) parmi ; , tabulation. */
function detecterSeparateur(premiere: string): string {
  const compte: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  let entreGuillemets = false;
  for (const c of premiere) {
    if (c === '"') entreGuillemets = !entreGuillemets;
    else if (!entreGuillemets && c in compte) compte[c]++;
  }
  const [premier] = Object.entries(compte).sort((a, b) => b[1] - a[1]);
  return premier[1] ? premier[0] : ";";
}

export function lireCsv(texte: string): Csv {
  texte = texte.replace(/^﻿/, "");
  const separateur = detecterSeparateur(texte.slice(0, texte.search(/\r?\n|$/)));
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let cellule = "";
  let entreGuillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (entreGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { cellule += '"'; i++; }
      else if (c === '"') entreGuillemets = false;
      else cellule += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === separateur) { ligne.push(cellule); cellule = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texte[i + 1] === "\n") i++;
      ligne.push(cellule);
      lignes.push(ligne);
      ligne = [];
      cellule = "";
    } else cellule += c;
  }
  if (cellule || ligne.length) { ligne.push(cellule); lignes.push(ligne); }
  const nonVides = lignes.filter((l) => l.some((c) => c.trim()));
  return { separateur, entetes: (nonVides[0] ?? []).map((e) => e.trim()), lignes: nonVides.slice(1) };
}

/**
 * « 12,50 », « 12.50 », « 1 234,50 € », « -3,00 », « (3,00) », « 1,234.50 » → centimes.
 * `enCentimes` : le fichier donne déjà des centimes entiers (« 1250 »).
 */
export function lireMontant(s: string, enCentimes = false): number | null {
  let t = s.replace(/[\s  €]|EUR/gi, "");
  let negatif = false;
  if (/^\(.*\)$/.test(t)) { negatif = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { negatif = true; t = t.slice(1); }
  else if (t.endsWith("-")) { negatif = true; t = t.slice(0, -1); }
  if (!t) return null;
  if (enCentimes) {
    if (!/^\d+$/.test(t)) return null;
    return (negatif ? -1 : 1) * Number(t);
  }
  // Le dernier séparateur (, ou .) est la décimale ; les autres sont des milliers
  const dernier = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  const entier = dernier >= 0 ? t.slice(0, dernier).replace(/[.,]/g, "") : t;
  const decimales = dernier >= 0 ? t.slice(dernier + 1) : "";
  if (!/^\d*$/.test(entier) || !/^\d{0,3}$/.test(decimales) || (!entier && !decimales)) return null;
  // 3 chiffres après un unique séparateur : « 1.234 » est un millier, pas 1,234 €
  if (decimales.length === 3) return (negatif ? -1 : 1) * Number(entier + decimales) * 100;
  const cents = Number(entier || "0") * 100 + Number(decimales.padEnd(2, "0"));
  return negatif ? -cents : cents;
}

/**
 * Date (et heure) d'une ligne → instant UTC. Sans fuseau explicite, l'heure est celle de Paris.
 * Formats : JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AAAA, AAAA-MM-JJ, suivis ou non de HH:MM[:SS] ;
 * ISO 8601 avec fuseau (Z, +02:00). `heure` : colonne séparée éventuelle.
 */
export function lireDate(date: string, heure?: string): Date | null {
  const s = `${date.trim()}${heure?.trim() ? ` ${heure.trim()}` : ""}`;
  if (/[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s) && /^\d{4}-/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]+(\d{1,2})[:hH](\d{2})(?::(\d{2}))?)?$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let a: number, mo: number, j: number, h = 0, mi = 0, se = 0;
  if (m) [j, mo, a, h, mi, se] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
  else if (iso) [a, mo, j, h, mi, se] = [+iso[1], +iso[2], +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0)];
  else return null;
  if (mo < 1 || mo > 12 || j < 1 || j > 31 || h > 23 || mi > 59 || se > 59) return null;
  const d = new TZDate(a, mo - 1, j, h, mi, se, FUSEAU_METIER);
  if (d.getDate() !== j) return null; // 31/02…
  return new Date(d.getTime());
}

export interface Colonnes {
  date: number;
  heure?: number | null;
  montant: number;
  reference?: number | null;
  terminal: number;
}

const normaliser = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Colonnes devinées d'après les en-têtes ; l'utilisateur confirme ou corrige. */
export function suggererColonnes(entetes: string[]): Partial<Colonnes> {
  const n = entetes.map(normaliser);
  const trouver = (re: RegExp, sauf: number[] = []) => {
    const i = n.findIndex((e, k) => re.test(e) && !sauf.includes(k));
    return i >= 0 ? i : undefined;
  };
  const date = trouver(/date|jour|horodatage|timestamp/);
  const heure = trouver(/heure|^time|hour/, date !== undefined ? [date] : []);
  const montant = trouver(/montant|amount|somme|total|valeur/);
  const reference = trouver(/autoris|auth|reference|^ref|numero de transaction|transaction/);
  const terminal = trouver(/terminal|tid|tpe|^id terminal|equipement|appareil/);
  return { date, heure, montant, reference, terminal };
}

export interface LigneReleve {
  numero: number; // ligne du fichier (1 = en-tête)
  terminal: string;
  horodatage: Date;
  montantCents: number;
  reference: string | null;
}

/** Lignes interprétées selon les colonnes choisies, et erreurs ligne par ligne. */
export function interpreter(csv: Csv, c: Colonnes, enCentimes = false) {
  const lignes: LigneReleve[] = [];
  const erreurs: { ligne: number; message: string }[] = [];
  csv.lignes.forEach((l, i) => {
    const numero = i + 2;
    const terminal = (l[c.terminal] ?? "").trim();
    const horodatage = lireDate(l[c.date] ?? "", c.heure != null ? l[c.heure] : undefined);
    const montantCents = lireMontant(l[c.montant] ?? "", enCentimes);
    const reference = c.reference != null ? (l[c.reference] ?? "").trim() || null : null;
    if (!terminal) erreurs.push({ ligne: numero, message: "terminal manquant" });
    else if (!horodatage) erreurs.push({ ligne: numero, message: `date illisible : « ${[l[c.date], c.heure != null ? l[c.heure] : ""].join(" ").trim()} »` });
    else if (montantCents === null) erreurs.push({ ligne: numero, message: `montant illisible : « ${l[c.montant] ?? ""} »` });
    else lignes.push({ numero, terminal, horodatage, montantCents, reference });
  });
  return { lignes, erreurs };
}
