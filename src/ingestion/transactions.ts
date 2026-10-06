import { Prisma, type Borne, type MoyenPaiement, type TransactionStatut } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { htDepuisTtc, pctVersBp } from "../lib/montants.js";
import { jourEtHeureLocaux, offsetMinutes } from "../lib/temps.js";
import { ajouterAuxAgregats, type LigneAgregee } from "./agregats.js";
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
// Au-delà, une date dans le futur trahit une horloge de borne déréglée : la vente est rejetée
const TOLERANCE_FUTUR_MS = 60 * 60_000;

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

interface Candidate {
  index: number;
  t: TransactionJson;
  horodatage: Date;
  statut: TransactionStatut;
  moyenPaiement: MoyenPaiement;
  typeModuleId: number;
  tauxTvaBp: number;
}

/** Deux envois d'une même transaction sont-ils identiques ? (sinon : conflit, jamais écrasé) */
const identique = (
  a: { horodatage: Date; montantTtcCents: number; statut: TransactionStatut; moyenPaiement: MoyenPaiement; typeModuleId: number; produitCode: string },
  c: Candidate
) =>
  a.horodatage.getTime() === c.horodatage.getTime() &&
  a.montantTtcCents === c.t.montant_ttc_centimes &&
  a.statut === c.statut &&
  a.moyenPaiement === c.moyenPaiement &&
  a.typeModuleId === c.typeModuleId &&
  a.produitCode === c.t.produit.code;

/**
 * Intègre un lot de transactions déjà authentifié (borne) et dont l'enveloppe est valide.
 * Idempotent : (borne, transaction_id) existant et identique → doublon, sans effet.
 * Les vérifications se font en mémoire, puis le lot est écrit en une seule transaction SQL
 * (insertions et agrégats), ce qui garde un rattrapage de 500 ventes rapide.
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

  const typesModule = new Map((await prisma.typeModulePaiement.findMany({ where: { actif: true } })).map((t) => [t.code, t]));
  const erreurs: ErreurLigne[] = [];
  let doublons = 0;
  const limiteFutur = Date.now() + TOLERANCE_FUTUR_MS;

  // ─── 1. Vérifications ligne par ligne (en mémoire) ───
  const candidates = new Map<string, Candidate>(); // par transaction_id
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
    if (horodatage.getTime() > limiteFutur) {
      rejeter("HORODATAGE_FUTUR", `Vente datée du ${t.horodatage}, dans le futur : horloge de la borne à vérifier (NTP)`);
      continue;
    }
    const c: Candidate = {
      index,
      t,
      horodatage,
      statut: STATUTS[t.statut],
      moyenPaiement: t.moyen_paiement.toUpperCase() as MoyenPaiement,
      typeModuleId: typeModule.id,
      tauxTvaBp: t.taux_tva_pct !== undefined ? pctVersBp(t.taux_tva_pct) : TVA_DEFAUT_BP,
    };
    // Même transaction_id deux fois dans le lot
    const deja = candidates.get(t.transaction_id);
    if (deja) {
      if (identique({ ...deja, montantTtcCents: deja.t.montant_ttc_centimes, produitCode: deja.t.produit.code }, c)) doublons++;
      else rejeter("CONFLIT_DOUBLON", "transaction_id présent deux fois dans le lot avec un contenu différent");
      continue;
    }
    candidates.set(t.transaction_id, c);
  }

  // ─── 2. Recherches groupées : déjà reçues, affectations, modules, ventes d'origine ───
  const ids = [...candidates.keys()];
  const [existantes, affectations, modules] = await Promise.all([
    prisma.transaction.findMany({ where: { borneId: borne.id, transactionIdModule: { in: ids } } }),
    prisma.affectationBorne.findMany({ where: { borneId: borne.id } }),
    prisma.modulePaiement.findMany({
      where: { numeroSerie: { in: [...candidates.values()].map((c) => c.t.module.numero_serie).filter((n): n is string => !!n) } },
    }),
  ]);
  for (const e of existantes) {
    const c = candidates.get(e.transactionIdModule)!;
    if (identique(e, c)) doublons++;
    else erreurs.push({ index: c.index, transaction_id: e.transactionIdModule, code: "CONFLIT_DOUBLON", message: `transaction_id déjà reçu (#${e.id}) avec un contenu différent : non écrasé` });
    candidates.delete(e.transactionIdModule);
  }
  const idsOrigine = [...new Set([...candidates.values()].map((c) => c.t.transaction_origine_id).filter((x): x is string => !!x))];
  const origines = new Map(
    (await prisma.transaction.findMany({ where: { borneId: borne.id, transactionIdModule: { in: idsOrigine } }, select: { id: true, transactionIdModule: true } })).map(
      (o) => [o.transactionIdModule, o.id]
    )
  );

  // Lieu actif à la date de chaque transaction (CDC §3.2)
  const affectationA = (h: Date) => affectations.find((a) => a.debut <= h && (!a.fin || a.fin > h));
  const lignes = [...candidates.values()].map((c) => {
    const affectation = affectationA(c.horodatage);
    const { jour, heure } = jourEtHeureLocaux(c.horodatage);
    const module = c.t.module.numero_serie ? modules.find((m) => m.typeId === c.typeModuleId && m.numeroSerie === c.t.module.numero_serie) : undefined;
    return {
      c,
      heure,
      data: {
        borneId: borne.id,
        transactionIdModule: c.t.transaction_id,
        lieuId: affectation?.lieuId ?? null,
        affectationId: affectation?.id ?? null,
        horodatage: c.horodatage,
        offsetMinutes: offsetMinutes(c.t.horodatage),
        jourLocal: jour,
        montantTtcCents: c.t.montant_ttc_centimes,
        tauxTvaBp: c.tauxTvaBp,
        montantHtCents: htDepuisTtc(c.t.montant_ttc_centimes, c.tauxTvaBp),
        devise: c.t.devise,
        statut: c.statut,
        typeModuleId: c.typeModuleId,
        moduleId: module?.id ?? null,
        moyenPaiement: c.moyenPaiement,
        referenceMonetique: c.t.reference_monetique ?? null,
        produitCode: c.t.produit.code,
        produitLibelle: c.t.produit.libelle ?? null,
        nbTirages: c.t.produit.nb_tirages,
        transactionOrigineId: c.t.transaction_origine_id ? (origines.get(c.t.transaction_origine_id) ?? null) : null,
        logicielVersion: lot.logiciel_version,
        importId: importLot.id,
        rapprochement: c.moyenPaiement === "ESPECES" ? ("NON_APPLICABLE" as const) : ("NON_RAPPROCHE" as const),
      } satisfies Prisma.TransactionCreateManyInput,
    };
  });

  // ─── 3. Écriture en une transaction : insertions + agrégats ───
  const inserees = lignes.length
    ? await prisma.$transaction(
        async (db) => {
          // skipDuplicates : un envoi concurrent du même lot ne compte rien deux fois
          const creees = await db.transaction.createManyAndReturn({
            data: lignes.map((l) => l.data),
            skipDuplicates: true,
            select: { id: true, transactionIdModule: true },
          });
          const parId = new Map(creees.map((x) => [x.transactionIdModule, x.id]));

          // Remboursement envoyé dans le même lot que la vente d'origine
          for (const l of lignes) {
            const o = l.c.t.transaction_origine_id;
            const id = parId.get(l.data.transactionIdModule);
            if (o && id && !l.data.transactionOrigineId && parId.has(o)) {
              await db.transaction.update({ where: { id }, data: { transactionOrigineId: parId.get(o) } });
            }
          }

          const nouvelles = lignes.filter((l) => parId.has(l.data.transactionIdModule));
          await ajouterAuxAgregats(
            db,
            nouvelles
              .filter((l) => l.data.lieuId !== null)
              .map(
                (l): LigneAgregee => ({
                  jour: l.data.jourLocal,
                  heure: l.heure,
                  lieuId: l.data.lieuId!,
                  borneId: borne.id,
                  typeModuleId: l.data.typeModuleId,
                  moyenPaiement: l.data.moyenPaiement,
                  statut: l.data.statut,
                  montantTtcCents: l.data.montantTtcCents,
                  montantHtCents: l.data.montantHtCents,
                  nbTirages: l.data.nbTirages,
                })
              )
          );
          return nouvelles;
        },
        { timeout: 60_000 }
      )
    : [];
  doublons += lignes.length - inserees.length;

  const nonAffectees = inserees.filter((l) => l.data.lieuId === null);
  const joursNonAffectes = new Set(nonAffectees.map((l) => l.data.jourLocal.toISOString().slice(0, 10)));
  const derniereVente = inserees
    .filter((l) => l.data.statut === "ACCEPTEE")
    .reduce<Date | null>((m, l) => (!m || l.data.horodatage > m ? l.data.horodatage : m), null);

  await prisma.importLot.update({
    where: { id: importLot.id },
    data: {
      statut: erreurs.length === 0 ? "OK" : erreurs.length === lot.transactions.length ? "REJETE" : "PARTIEL",
      nbRecues: lot.transactions.length,
      nbCreees: inserees.length,
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
      ...(derniereVente && (!borne.derniereVente || derniereVente > borne.derniereVente) ? { derniereVente } : {}),
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
    creees: inserees.length,
    doublons,
    rejetees: erreurs.length,
    non_affectees: nonAffectees.length,
    erreurs,
  };
}
