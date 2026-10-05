import { Prisma, type Borne, type MoyenPaiement, type TransactionStatut } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { htDepuisTtc, pctVersBp } from "../lib/montants.js";
import { jourEtHeureLocaux, offsetMinutes } from "../lib/temps.js";
import { incrementerAgregats } from "./agregats.js";
import { sha256Payload } from "./journal.js";
import {
  formaterErreurs,
  validerTransaction,
  type LotTransactionsJson,
  type TransactionJson,
} from "./validation.js";

const STATUTS: Record<TransactionJson["statut"], TransactionStatut> = {
  accepte: "ACCEPTEE",
  refuse: "REFUSEE",
  annule: "ANNULEE",
  rembourse: "REMBOURSEE",
};

const TVA_DEFAUT_BP = Number(process.env.TVA_DEFAUT_BP ?? 2000);

export interface ErreurLigne {
  index: number;
  transaction_id?: string;
  code: string;
  message: string;
}

export interface ResultatLot {
  import_id: string;
  recues: number;
  creees: number;
  doublons: number;
  rejetees: number;
  non_affectees: number;
  erreurs: ErreurLigne[];
}

/**
 * Intègre un lot de transactions déjà authentifié (borne) et dont l'enveloppe est valide.
 * Idempotent : (borne, transaction_id) existant et identique → doublon, sans effet.
 */
export async function ingererLotTransactions(
  borne: Borne,
  lot: LotTransactionsJson,
  ipSource: string | undefined
): Promise<ResultatLot> {
  const importLot = await prisma.importLot.create({
    data: {
      source: "API",
      type: "TRANSACTIONS",
      borneId: borne.id,
      borneIdentifiant: borne.identifiant,
      schemaVersion: lot.schema_version,
      payloadSha256: sha256Payload(lot),
      payload: lot as unknown as Prisma.InputJsonValue,
      ipSource,
      statut: "OK",
    },
  });

  const typesModule = new Map(
    (await prisma.typeModulePaiement.findMany({ where: { actif: true } })).map((t) => [t.code, t])
  );

  const erreurs: ErreurLigne[] = [];
  let creees = 0;
  let doublons = 0;
  let nonAffectees = 0;
  const joursNonAffectes = new Set<string>();
  let derniereVente: Date | null = null;

  for (const [index, brut] of lot.transactions.entries()) {
    const rejeter = (code: string, message: string) =>
      erreurs.push({ index, transaction_id: (brut as { transaction_id?: string })?.transaction_id, code, message });

    if (!validerTransaction(brut)) {
      rejeter("SCHEMA_INVALIDE", formaterErreurs(validerTransaction.errors));
      continue;
    }
    const t = brut as TransactionJson;

    const typeModule = typesModule.get(t.module.type);
    if (!typeModule) {
      rejeter("MODULE_INCONNU", `Type de module "${t.module.type}" absent du référentiel`);
      continue;
    }
    if (t.devise !== "EUR") {
      rejeter("DEVISE_NON_GEREE", `Devise ${t.devise} non gérée`);
      continue;
    }

    const horodatage = new Date(t.horodatage);
    const statut = STATUTS[t.statut];
    const moyenPaiement = t.moyen_paiement.toUpperCase() as MoyenPaiement;
    const tauxTvaBp = t.taux_tva_pct !== undefined ? pctVersBp(t.taux_tva_pct) : TVA_DEFAUT_BP;

    const existante = await prisma.transaction.findUnique({
      where: { borneId_transactionIdModule: { borneId: borne.id, transactionIdModule: t.transaction_id } },
    });
    if (existante) {
      const identique =
        existante.horodatage.getTime() === horodatage.getTime() &&
        existante.montantTtcCents === t.montant_ttc_centimes &&
        existante.statut === statut &&
        existante.moyenPaiement === moyenPaiement &&
        existante.typeModuleId === typeModule.id &&
        existante.produitCode === t.produit.code;
      if (identique) doublons++;
      else
        rejeter(
          "CONFLIT_DOUBLON",
          `transaction_id déjà reçu (#${existante.id}) avec un contenu différent : non écrasé`
        );
      continue;
    }

    // Lieu actif à la date de la transaction (CDC §3.2)
    const affectation = await prisma.affectationBorne.findFirst({
      where: {
        borneId: borne.id,
        debut: { lte: horodatage },
        OR: [{ fin: null }, { fin: { gt: horodatage } }],
      },
    });

    const module = t.module.numero_serie
      ? await prisma.modulePaiement.findUnique({
          where: { typeId_numeroSerie: { typeId: typeModule.id, numeroSerie: t.module.numero_serie } },
        })
      : null;

    const origine = t.transaction_origine_id
      ? await prisma.transaction.findUnique({
          where: {
            borneId_transactionIdModule: { borneId: borne.id, transactionIdModule: t.transaction_origine_id },
          },
          select: { id: true },
        })
      : null;

    const { jour, heure } = jourEtHeureLocaux(horodatage);
    const montantHtCents = htDepuisTtc(t.montant_ttc_centimes, tauxTvaBp);

    try {
      await prisma.$transaction(async (db) => {
        await db.transaction.create({
          data: {
            borneId: borne.id,
            transactionIdModule: t.transaction_id,
            lieuId: affectation?.lieuId,
            affectationId: affectation?.id,
            horodatage,
            offsetMinutes: offsetMinutes(t.horodatage),
            jourLocal: jour,
            montantTtcCents: t.montant_ttc_centimes,
            tauxTvaBp,
            montantHtCents,
            devise: t.devise,
            statut,
            typeModuleId: typeModule.id,
            moduleId: module?.id,
            moyenPaiement,
            referenceMonetique: t.reference_monetique,
            produitCode: t.produit.code,
            produitLibelle: t.produit.libelle,
            nbTirages: t.produit.nb_tirages,
            transactionOrigineId: origine?.id,
            logicielVersion: lot.logiciel_version,
            importId: importLot.id,
            rapprochement: moyenPaiement === "ESPECES" ? "NON_APPLICABLE" : "NON_RAPPROCHE",
          },
        });

        if (affectation) {
          await incrementerAgregats(db, {
            jour,
            heure,
            lieuId: affectation.lieuId,
            borneId: borne.id,
            typeModuleId: typeModule.id,
            moyenPaiement,
            statut,
            montantTtcCents: t.montant_ttc_centimes,
            montantHtCents,
            nbTirages: t.produit.nb_tirages,
          });
        }
      });
    } catch (err) {
      // Même transaction insérée en parallèle par un autre envoi : c'est un doublon
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        doublons++;
        continue;
      }
      throw err;
    }

    creees++;
    if (!affectation) {
      nonAffectees++;
      joursNonAffectes.add(jour.toISOString().slice(0, 10));
    }
    if (statut === "ACCEPTEE" && (!derniereVente || horodatage > derniereVente)) derniereVente = horodatage;
  }

  await prisma.importLot.update({
    where: { id: importLot.id },
    data: {
      statut: erreurs.length === 0 ? "OK" : erreurs.length === lot.transactions.length ? "REJETE" : "PARTIEL",
      nbRecues: lot.transactions.length,
      nbCreees: creees,
      nbDoublons: doublons,
      nbRejetees: erreurs.length,
      erreurs: {
        create: erreurs.map((e) => ({
          index: e.index,
          transactionIdModule: e.transaction_id?.slice(0, 128),
          code: e.code,
          message: e.message,
          payload: (lot.transactions[e.index] ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        })),
      },
    },
  });

  await prisma.borne.update({
    where: { id: borne.id },
    data: {
      logicielVersion: lot.logiciel_version,
      ...(derniereVente && (!borne.derniereVente || derniereVente > borne.derniereVente)
        ? { derniereVente }
        : {}),
    },
  });

  // Transactions sans lieu : stockées, et signalées (une alerte par borne et par jour)
  if (joursNonAffectes.size > 0) {
    await prisma.alerte.createMany({
      skipDuplicates: true,
      data: [...joursNonAffectes].map((j) => ({
        type: "BORNE_NON_AFFECTEE" as const,
        niveau: "WARNING" as const,
        borneId: borne.id,
        cleDedup: `BORNE_NON_AFFECTEE:${borne.id}:${j}`,
        message: `La borne ${borne.identifiant} a remonté des ventes le ${j} sans être affectée à un lieu`,
      })),
    });
  }

  return {
    import_id: importLot.id.toString(),
    recues: lot.transactions.length,
    creees,
    doublons,
    rejetees: erreurs.length,
    non_affectees: nonAffectees,
    erreurs,
  };
}
