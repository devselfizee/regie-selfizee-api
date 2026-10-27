import { Prisma, type Borne, type ImportSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { jourEtHeureLocaux } from "../lib/temps.js";
import { sha256Payload } from "./journal.js";
import type { LotParcoursJson, ParcoursJson } from "./validation.js";

// Parcours invité (avenant du 26/10/2026) : une séance du kit nightlife, vente ou pas.
// Mêmes règles que les ventes : (borne, parcours_id) unique ; renvoi identique = doublon,
// contenu différent = CONFLIT_DOUBLON (l'original est gardé) ; lieu = affectation au début de la séance.

export interface ResultatLotParcours {
  import_id: string;
  recus: number;
  crees: number;
  doublons: number;
  rejetees: number;
  non_affectees: number;
  erreurs: { index: number; parcours_id: string; code: string; message: string }[];
}

/** Forme canonique (clés triées) pour comparer un renvoi à l'original. */
const canonique = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export async function ingererLotParcours(
  borne: Borne,
  lot: LotParcoursJson,
  ipSource: string | undefined,
  source: ImportSource = "API",
  // Lignes refusées par le schéma (index → message) : rejetées seules, le reste du lot passe
  lignesInvalides: Map<number, string> = new Map()
): Promise<ResultatLotParcours> {
  const importLot = await prisma.importLot.create({
    data: {
      source,
      type: "PARCOURS",
      borneId: borne.id,
      borneIdentifiant: borne.identifiant,
      schemaVersion: lot.schema_version,
      payloadSha256: sha256Payload(lot),
      payload: lot as unknown as Prisma.InputJsonValue,
      ipSource,
      statut: "OK",
    },
  });

  const erreurs: ResultatLotParcours["erreurs"] = [];
  // Un même parcours_id deux fois dans le lot : le premier compte
  const candidats = new Map<string, { p: ParcoursJson; index: number }>();
  lot.parcours.forEach((p, index) => {
    const invalide = lignesInvalides.get(index);
    if (invalide) erreurs.push({ index, parcours_id: String((p as { parcours_id?: unknown })?.parcours_id ?? ""), code: "SCHEMA_INVALIDE", message: invalide });
    else if (candidats.has(p.parcours_id)) erreurs.push({ index, parcours_id: p.parcours_id, code: "DOUBLON_DANS_LE_LOT", message: "parcours_id présent deux fois dans le lot" });
    else candidats.set(p.parcours_id, { p, index });
  });

  const [existants, affectations] = await Promise.all([
    prisma.parcours.findMany({ where: { borneId: borne.id, parcoursId: { in: [...candidats.keys()] } }, select: { id: true, parcoursId: true, brut: true } }),
    prisma.affectationBorne.findMany({ where: { borneId: borne.id } }),
  ]);
  let doublons = 0;
  for (const e of existants) {
    const c = candidats.get(e.parcoursId)!;
    if (canonique(e.brut) === canonique(c.p)) doublons++;
    else erreurs.push({ index: c.index, parcours_id: e.parcoursId, code: "CONFLIT_DOUBLON", message: `parcours_id déjà reçu (#${e.id}) avec un contenu différent : non écrasé` });
    candidats.delete(e.parcoursId);
  }

  const affectationA = (h: Date) => affectations.find((a) => a.debut <= h && (!a.fin || a.fin > h));
  const lignes = [...candidats.values()].map(({ p }) => {
    const debut = new Date(p.debut);
    const affectation = affectationA(debut);
    const { jour, heure } = jourEtHeureLocaux(debut);
    return {
      borneId: borne.id,
      parcoursId: p.parcours_id,
      importId: importLot.id,
      lieuId: affectation?.lieuId ?? null,
      affectationId: affectation?.id ?? null,
      evenement: p.evenement,
      kit: p.kit,
      codeSeance: p.code_seance ?? null,
      photoUuid: p.photo_uuid ?? null,
      debut,
      fin: new Date(p.fin),
      jourLocal: jour,
      heureLocale: heure,
      dureeS: p.duree_s,
      issue: p.issue,
      etapes: p.etapes as Prisma.InputJsonValue,
      cadre: p.cadre ?? null,
      photos: p.photos,
      recommencer: p.recommencer ?? null,
      couleursRelances: p.couleurs_relances ?? null,
      retoursOffre: p.retours_offre ?? null,
      tirages: p.tirages,
      paiementDemandes: p.paiement?.demandes ?? null,
      paiementStatut: p.paiement?.statut ?? null,
      paiementMontantCents: p.paiement?.montant_ttc_centimes ?? null,
      upsellProposes: p.upsell?.proposes ?? null,
      upsellAcceptes: p.upsell?.acceptes ?? null,
      upsellMontantCents: p.upsell?.montant_ttc_centimes ?? null,
      appel: p.appel ?? null,
      appelEngagee: p.appel_engagee ?? null,
      brut: p as unknown as Prisma.InputJsonValue,
    };
  });

  // skipDuplicates : un envoi concurrent du même parcours ne fait pas échouer le lot
  const { count } = lignes.length ? await prisma.parcours.createMany({ data: lignes, skipDuplicates: true }) : { count: 0 };
  doublons += lignes.length - count;

  await prisma.importLot.update({
    where: { id: importLot.id },
    data: {
      statut: erreurs.length === 0 ? "OK" : erreurs.length === lot.parcours.length ? "REJETE" : "PARTIEL",
      nbRecues: lot.parcours.length,
      nbCreees: count,
      nbDoublons: doublons,
      nbRejetees: erreurs.length,
      ...(erreurs.length
        ? { erreurs: { create: erreurs.map((e) => ({ index: e.index, transactionIdModule: e.parcours_id, code: e.code, message: e.message, payload: lot.parcours[e.index] as unknown as Prisma.InputJsonValue })) } }
        : {}),
    },
  });

  return {
    import_id: importLot.id.toString(),
    recus: lot.parcours.length,
    crees: count,
    doublons,
    rejetees: erreurs.length,
    non_affectees: lignes.filter((l) => l.lieuId === null).length,
    erreurs,
  };
}
