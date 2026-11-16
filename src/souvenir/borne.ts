import { Prisma, type Media } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// Adresses e-mail tapées sur la borne (« Recevoir par e-mail », champ shareWithOthers du JSON de séance,
// docs/avenant-synchro-adresses-borne.md). La borne n'envoie rien elle-même : chaque adresse devient une
// inscription d'origine BORNE, livrée par le même mail que la page souvenir (src/souvenir/envois.ts), avec
// le même lien que le QR. La fiche revient avec la liste complète à chaque demande : une adresse déjà
// inscrite sur cette photo ne reçoit rien de plus (index unique code_event + photo_uuid + email).

export interface BilanInscriptionsBorne {
  creees: number;
  dejaServies: number;
  /** Adresses ignorées : séance sans photo_uuid, ou événement inconnu de la Régie */
  ignorees: number;
}

type SeanceBorne = Pick<Media, "codeEvent" | "photoUuid" | "configEvenementId" | "lieuId" | "mediaStatut">;

export async function inscrireDepuisBorne(m: SeanceBorne, adresses: string[]): Promise<BilanInscriptionsBorne> {
  const bilan: BilanInscriptionsBorne = { creees: 0, dejaServies: 0, ignorees: 0 };
  if (!adresses.length) return bilan;
  // Sans photo_uuid ou événement inconnu, pas de page souvenir à envoyer ; séance purgée (rétention, RGPD) : plus rien à livrer
  if (!m.photoUuid || !m.configEvenementId || m.mediaStatut === "PURGE") {
    bilan.ignorees = adresses.length;
    return bilan;
  }
  const seance = { codeEvent: m.codeEvent, photoUuid: m.photoUuid };
  const existantes = new Set(
    (await prisma.souvenirInscription.findMany({ where: { ...seance, email: { in: adresses } }, select: { email: true } })).map((i) => i.email)
  );
  // Photo déjà copiée : le mail part à la prochaine passe du planificateur ; sinon il attend la photo (rattraperLivraisons)
  const etat = m.mediaStatut === "TELECHARGE" ? "A_ENVOYER" : "EN_ATTENTE_MEDIA";
  for (const email of adresses) {
    if (existantes.has(email)) {
      bilan.dejaServies++;
      continue;
    }
    try {
      await prisma.souvenirInscription.create({
        data: {
          ...seance,
          configEvenementId: m.configEvenementId,
          lieuId: m.lieuId,
          email,
          // La borne ne propose ni prénom ni cases à cocher : c'est l'invité qui a tapé sa propre adresse
          estMoi: true,
          optinLieu: false,
          optinSelfizee: false,
          textes: [],
          origine: "BORNE",
          livraisons: { create: { etat } },
        },
      });
      await prisma.souvenirJournal.create({ data: { evenement: "registered", ...seance, lieuId: m.lieuId, details: { origine: "borne" } } });
      bilan.creees++;
    } catch (e) {
      // Deux fiches reçues en même temps pour la même adresse : l'index unique tranche
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") bilan.dejaServies++;
      else throw e;
    }
  }
  return bilan;
}
