import { Prisma, type Borne } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { LotHeartbeatsJson } from "./validation.js";

/**
 * Enregistre les heartbeats d'une borne. (borne, horodatage) est unique :
 * un rattrapage qui renvoie des heartbeats déjà reçus n'a pas d'effet.
 * Les heartbeats valides ne créent pas de lot d'import (volume : 288/jour/borne).
 */
export async function ingererHeartbeats(borne: Borne, lot: LotHeartbeatsJson) {
  const { count } = await prisma.heartbeat.createMany({
    skipDuplicates: true,
    data: lot.heartbeats.map((h) => ({
      borneId: borne.id,
      horodatage: new Date(h.horodatage),
      papierRestant: h.papier_restant,
      rubanRestant: h.ruban_restant,
      imprimanteOk: h.imprimante_ok,
      modulePaiementOk: h.module_paiement_ok,
      erreurs: h.erreurs?.length ? (h.erreurs as Prisma.InputJsonValue) : Prisma.JsonNull,
      logicielVersion: h.logiciel_version,
    })),
  });

  const plusRecent = lot.heartbeats.reduce((a, h) => {
    const d = new Date(h.horodatage);
    return d > a.date ? { date: d, version: h.logiciel_version } : a;
  }, { date: new Date(0), version: "" });

  // Un heartbeat daté dans le futur (horloge borne déréglée) ne doit pas masquer une panne
  const maintenant = new Date(Date.now() + 5 * 60_000);
  if (plusRecent.date <= maintenant && (!borne.dernierHeartbeat || plusRecent.date > borne.dernierHeartbeat)) {
    await prisma.borne.update({
      where: { id: borne.id },
      data: { dernierHeartbeat: plusRecent.date, logicielVersion: plusRecent.version },
    });
  }

  return { recus: lot.heartbeats.length, crees: count, doublons: lot.heartbeats.length - count };
}
