import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { conditionsLieu, et, periodesComparaison, ymd, type Filtres } from "./filtres.js";

// Analyse des paiements (maquette « Paiements », onglet Analyse) : ce qui se passe entre l'appui sur « Payer »
// et le tirage. Unité : la demande de paiement, une par séance (parcours invité de l'avenant du 26/10/2026).
// Chaque séance est reliée à ses passages au terminal (ventes) par l'identifiant : transaction_id
// = <parcours_id>-<rang> sur la même borne (docs/synchronisation-bornes.md).

/** Au-delà, une annulation est « après attente » ; en dessous, « immédiate » */
export const SEUIL_ATTENTE_S = 15;
/** Au-delà, l'acceptation a demandé une relance (le terminal attend 60 s avant d'abandonner) */
export const SEUIL_LENT_S = 60;

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

interface Passage {
  statut: "ACCEPTEE" | "REFUSEE" | "ANNULEE" | "EXPIREE" | "OFFERTE";
  motif: "INVITE" | "BANQUE" | "TERMINAL" | null;
  encaissement: "CONFIRME" | "INCERTAIN" | null;
  montant: number;
  h: string;
  test: boolean;
}

interface LigneSeance {
  borne_id: number;
  identifiant: string;
  lieu_id: number;
  enseigne: string;
  heure_locale: number;
  affichee: Date | null;
  demande: Date | null;
  impression: Date | null;
  paiement_demandes: number | null;
  paiement_statut: string | null;
  paiement_montant_cents: number | null;
  passages: Passage[] | null;
}

type Branche = "annule_vite" | "annule_attente" | "annule_inconnu" | "accepte" | "refus_banque" | "refus_terminal" | "muet" | "sans_vente";

/** Une demande de paiement, avec ce que l'on sait de son chemin */
interface Seance {
  borneId: number;
  identifiant: string;
  lieu: { id: number; enseigne: string };
  heure: number;
  branche: Branche;
  paye: boolean;
  offert: boolean;
  incertain: boolean;
  montantCents: number;
  passages: Passage[];
  /** « Payer » → premier verdict du terminal (s) */
  delaiPremierS: number | null;
  /** Premier passage → passage accepté (s), quand le premier n'a pas abouti */
  delaiRetenteS: number | null;
  /** « Payer » → départ du tirage (s) */
  demandeATirageS: number | null;
  /** Page de paiement affichée → « Payer » (s) */
  pageAPayerS: number | null;
  demandesRepetees: boolean;
}

const secondes = (de: Date | string | null | undefined, a: Date | string | null | undefined) => {
  if (!de || !a) return null;
  const s = (new Date(a).getTime() - new Date(de).getTime()) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
};

/** Médiane (comme percentile_cont(0.5)) ; null sans valeur */
export function mediane(valeurs: (number | null)[]): number | null {
  const v = valeurs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Centile (interpolé) ; null sans valeur */
function centile(valeurs: number[], p: number): number | null {
  const v = [...valeurs].sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const bas = Math.floor(i);
  return v[bas] + (v[Math.min(bas + 1, v.length - 1)] - v[bas]) * (i - bas);
}

const arrondi = (s: number | null) => (s === null ? null : Math.round(s * 10) / 10);

/** Séances de la période qui ont demandé un paiement, avec leurs passages au terminal */
async function lireSeances(f: Filtres): Promise<LigneSeance[]> {
  const c = [Prisma.sql`p.jour_local BETWEEN ${ymd(f.du)}::date AND ${ymd(f.au)}::date`, ...conditionsLieu(f)];
  if (f.gammeId?.length) c.push(Prisma.sql`b.gamme_id IN (${Prisma.join(f.gammeId)})`);
  return prisma.$queryRaw<LigneSeance[]>`
    SELECT p.borne_id, b.identifiant, l.id lieu_id, l.enseigne, p.heure_locale,
           (p.etapes ->> 'paiement')::timestamptz affichee,
           (p.etapes ->> 'paiement_demande')::timestamptz demande,
           (p.etapes ->> 'impression')::timestamptz impression,
           p.paiement_demandes, p.paiement_statut, p.paiement_montant_cents, v.passages
    FROM parcours p JOIN lieux l ON l.id = p.lieu_id JOIN bornes b ON b.id = p.borne_id
    LEFT JOIN LATERAL (
      -- Passages de la séance, dans l'ordre : ni remboursements, ni « +1 pour un pote », ni séances à 0 €.
      -- La fenêtre d'horodatage ne sert qu'à profiter de l'index (borne, horodatage).
      SELECT json_agg(json_build_object('statut', a.statut, 'motif', a.motif, 'encaissement', a.encaissement,
                                        'montant', a.montant_ttc_cents, 'h', a.horodatage, 'test', a.test)
                      ORDER BY a.horodatage, a.id) passages
      FROM transactions a
      WHERE a.borne_id = p.borne_id
        AND a.horodatage BETWEEN p.debut - interval '1 hour' AND p.fin + interval '6 hours'
        AND regexp_replace(a.transaction_id_module, '-[0-9]+$', '') = p.parcours_id
        AND a.statut <> 'REMBOURSEE' AND a.produit_code <> 'TIRAGE_EXTRA' AND a.moyen_paiement <> 'AUCUN'
    ) v ON TRUE
    WHERE ${et(c)} AND ((p.etapes ->> 'paiement_demande') IS NOT NULL OR p.paiement_demandes IS NOT NULL)`;
}

const ACCEPTE = (p: Passage) => p.statut === "ACCEPTEE" || p.statut === "OFFERTE";

/** Classe une séance ; null pour une séance payée avec une carte de test (hors chiffres) */
function seance(r: LigneSeance): Seance | null {
  const passages = r.passages ?? [];
  if (passages.some((p) => p.test)) return null;
  const premier = passages[0];
  const accepte = [...passages].reverse().find(ACCEPTE);
  const sansVente = !passages.length;
  const paye = sansVente ? r.paiement_statut === "accepte" || r.paiement_statut === "offert" : !!accepte;
  const delaiPremierS = premier ? secondes(r.demande, premier.h) : null;

  let branche: Branche;
  if (!premier) branche = "sans_vente";
  else if (premier.statut === "ANNULEE")
    branche = delaiPremierS === null ? "annule_inconnu" : delaiPremierS < SEUIL_ATTENTE_S ? "annule_vite" : "annule_attente";
  else if (ACCEPTE(premier)) branche = "accepte";
  else if (premier.statut === "REFUSEE") branche = premier.motif === "TERMINAL" ? "refus_terminal" : "refus_banque";
  else branche = "muet";

  return {
    borneId: r.borne_id,
    identifiant: r.identifiant,
    lieu: { id: r.lieu_id, enseigne: r.enseigne },
    heure: r.heure_locale,
    branche,
    paye,
    offert: sansVente ? r.paiement_statut === "offert" : accepte?.statut === "OFFERTE",
    incertain: accepte?.statut === "ACCEPTEE" && accepte.encaissement === "INCERTAIN",
    montantCents: r.paiement_montant_cents ?? accepte?.montant ?? premier?.montant ?? 0,
    passages,
    delaiPremierS,
    delaiRetenteS: accepte && premier && !ACCEPTE(premier) ? secondes(premier.h, accepte.h) : null,
    demandeATirageS: paye ? secondes(r.demande, r.impression) : null,
    pageAPayerS: secondes(r.affichee, r.demande),
    demandesRepetees: n(r.paiement_demandes) > 1 || passages.length > 1,
  };
}

/** Repaie ou part : les deux issues d'une branche, disjointes */
function issue(s: Seance[]) {
  const payes = s.filter((x) => x.paye);
  const partis = s.filter((x) => !x.paye);
  return {
    nb: s.length,
    montantCents: s.reduce((t, x) => t + x.montantCents, 0),
    paye: { nb: payes.length, offerts: payes.filter((x) => x.offert).length, delaiMedianS: arrondi(mediane(payes.map((x) => x.delaiRetenteS))) },
    part: { nb: partis.length, montantCents: partis.reduce((t, x) => t + x.montantCents, 0) },
  };
}

const somme = (s: Seance[]) => ({ nb: s.length, montantCents: s.reduce((t, x) => t + x.montantCents, 0) });
const aUn = (x: Seance, statut: Passage["statut"], motif?: Passage["motif"]) => x.passages.some((p) => p.statut === statut && (motif === undefined || p.motif === motif || (motif === "BANQUE" && p.motif === null)));

/** Cause d'une demande non aboutie : le dernier passage sans débit */
function cause(x: Seance): "abouti" | "annule" | "muet" | "refus" | "inconnu" {
  if (x.paye) return "abouti";
  const dernier = x.passages[x.passages.length - 1];
  if (!dernier) return "inconnu";
  return dernier.statut === "ANNULEE" ? "annule" : dernier.statut === "EXPIREE" ? "muet" : dernier.statut === "REFUSEE" ? "refus" : "inconnu";
}

/** Clés comparées à la période précédente */
function cles(s: Seance[]) {
  const offerts = s.filter((x) => x.offert);
  return {
    demandes: s.length,
    aboutis: s.filter((x) => x.paye).length,
    offerts: offerts.length,
    demandeATirageMedianeS: arrondi(mediane(s.map((x) => x.demandeATirageS))),
  };
}

/** Comparaison avant minuit / après 2 h (soirée de 6 h à 6 h) */
function groupeHoraire(s: Seance[]) {
  return {
    demandes: s.length,
    annulations: s.filter((x) => aUn(x, "ANNULEE")).length,
    refusBanque: s.filter((x) => aUn(x, "REFUSEE", "BANQUE")).length,
    demandeATirageMedianeS: arrondi(mediane(s.map((x) => x.demandeATirageS))),
  };
}

export async function analysePaiements(f: Filtres, borneId?: number) {
  const { precedente } = periodesComparaison(f);
  const [lignes, lignesAvant] = await Promise.all([lireSeances(f), lireSeances({ ...f, ...precedente })]);
  const toutes = lignes.map(seance).filter((x): x is Seance => x !== null);
  // Bornes de la période (pour le filtre), avant de restreindre à l'une d'elles
  const bornes = [...new Map(toutes.map((x) => [x.borneId, x.identifiant])).entries()]
    .map(([id, identifiant]) => ({ id, identifiant }))
    .sort((a, b) => a.identifiant.localeCompare(b.identifiant));
  const s = borneId ? toutes.filter((x) => x.borneId === borneId) : toutes;
  const avant = lignesAvant
    .map(seance)
    .filter((x): x is Seance => x !== null && (!borneId || x.borneId === borneId));

  const payes = s.filter((x) => x.paye);
  const branche = (b: Branche) => s.filter((x) => x.branche === b);
  const annules = s.filter((x) => x.branche.startsWith("annule"));
  const acceptes = branche("accepte");
  const muets = branche("muet");

  // « Payer » → départ du tirage : l'impression part à l'acceptation (règle de la borne)
  const durees = payes.map((x) => x.demandeATirageS).filter((x): x is number => x !== null);
  const rapides = durees.filter((d) => d < SEUIL_LENT_S);
  const derniere = rapides.length ? Math.min(SEUIL_LENT_S, Math.ceil((Math.max(...rapides) + 0.001) / 2) * 2) : 0;
  const histogramme = [
    ...Array.from({ length: derniere / 2 }, (_, i) => ({ de: i * 2, a: i * 2 + 2 as number | null, nb: rapides.filter((d) => d >= i * 2 && d < i * 2 + 2).length })),
    ...(durees.length > rapides.length ? [{ de: SEUIL_LENT_S, a: null, nb: durees.length - rapides.length }] : []),
  ];

  // Par tranche de 2 h, calées sur les heures paires
  const tranches = new Map<number, Seance[]>();
  for (const x of s) {
    const t = x.heure - (x.heure % 2);
    tranches.set(t, [...(tranches.get(t) ?? []), x]);
  }

  // Terminal par terminal
  const parBorne = new Map<number, Seance[]>();
  for (const x of s) parBorne.set(x.borneId, [...(parBorne.get(x.borneId) ?? []), x]);

  const offerts = s.filter((x) => x.offert);
  const incertains = s.filter((x) => x.incertain);

  return {
    seuils: { attenteS: SEUIL_ATTENTE_S, lentS: SEUIL_LENT_S },
    bornes,
    ...cles(s),
    precedente: cles(avant),
    offerts: somme(offerts),
    incertains: somme(incertains),
    // Montant des demandes payées et débitées (tirages offerts exclus)
    encaisseCents: payes.filter((x) => !x.offert).reduce((t, x) => t + x.montantCents, 0),
    demandeATirage: {
      nb: durees.length,
      medianeS: arrondi(mediane(durees)),
      p90S: arrondi(centile(durees, 0.9)),
      auDelaSeuil: durees.length - rapides.length,
    },
    histogramme,
    arbre: {
      demandes: s.length,
      demandesRepetees: s.filter((x) => x.demandesRepetees).length,
      pageAPayerMedianeS: arrondi(mediane(s.map((x) => x.pageAPayerS))),
      annule: {
        nb: annules.length,
        parInvite: annules.filter((x) => x.passages[0].motif === "INVITE").length,
        parTerminal: annules.filter((x) => x.passages[0].motif === "TERMINAL").length,
        delaiMedianS: arrondi(mediane(annules.map((x) => x.delaiPremierS))),
        vite: issue(branche("annule_vite")),
        attente: issue(branche("annule_attente")),
        inconnu: issue(branche("annule_inconnu")),
      },
      verdict: {
        nb: acceptes.length + branche("refus_banque").length + branche("refus_terminal").length + muets.length,
        accepte: {
          nb: acceptes.length,
          delaiMedianS: arrondi(mediane(acceptes.map((x) => x.delaiPremierS))),
          preleve: acceptes.filter((x) => !x.offert && !x.incertain).length,
          incertain: somme(acceptes.filter((x) => x.incertain)),
          offert: somme(acceptes.filter((x) => x.offert)),
        },
        refusBanque: issue(branche("refus_banque")),
        refusTerminal: issue(branche("refus_terminal")),
        muet: {
          nb: muets.length,
          passages: muets.reduce((t, x) => t + x.passages.filter((p) => p.statut === "EXPIREE").length, 0),
          relanceAccepte: { nb: muets.filter((x) => x.paye).length, delaiMedianS: arrondi(mediane(muets.filter((x) => x.paye).map((x) => x.delaiRetenteS))) },
          relancePart: somme(muets.filter((x) => !x.paye && x.passages.length > 1)),
          part: somme(muets.filter((x) => !x.paye && x.passages.length === 1)),
        },
      },
      sansVente: issue(branche("sans_vente")),
    },
    parTranche: [...tranches.entries()]
      .sort(([a], [b]) => ((a + 18) % 24) - ((b + 18) % 24))
      .map(([debut, l]) => {
        const c = l.map(cause);
        const nb = (k: ReturnType<typeof cause>) => c.filter((x) => x === k).length;
        return { debut, demandes: l.length, aboutis: nb("abouti"), annules: nb("annule"), muets: nb("muet"), refus: nb("refus"), inconnus: nb("inconnu") };
      }),
    avantMinuit: groupeHoraire(s.filter((x) => x.heure >= 6)),
    apres2h: groupeHoraire(s.filter((x) => x.heure >= 2 && x.heure < 6)),
    parBorne: [...parBorne.values()]
      .map((l) => ({
        borneId: l[0].borneId,
        identifiant: l[0].identifiant,
        lieu: l[l.length - 1].lieu,
        demandes: l.length,
        aboutis: l.filter((x) => x.paye).length,
        demandeATirageMedianeS: arrondi(mediane(l.map((x) => x.demandeATirageS))),
        muets: l.filter((x) => aUn(x, "EXPIREE")).length,
        refusBanque: l.filter((x) => aUn(x, "REFUSEE", "BANQUE")).length,
        offerts: somme(l.filter((x) => x.offert)),
      }))
      .sort((a, b) => b.demandes - a.demandes),
  };
}

export type AnalysePaiements = Awaited<ReturnType<typeof analysePaiements>>;
