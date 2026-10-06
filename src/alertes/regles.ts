import type { NiveauAlerte, TypeAlerte } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// Règles d'alerte par défaut (CDC §7). Réglables par l'admin : une règle globale
// (lieuId null) remplace ces valeurs, une règle d'un lieu remplace la globale.
export const REGLES_DEFAUT = {
  BORNE_MUETTE: { niveau: "CRITIQUE", parametres: { heures: 2 } },
  ZERO_VENTE: { niveau: "WARNING", parametres: { heures: 3, minVentesAttendues: 3 } },
  BAISSE_CA: { niveau: "WARNING", parametres: { fenetreJours: 7, referenceJours: 28, seuilPct: 60, seuilCritiquePct: 30, minCaJourReferenceEuros: 20 } },
  TAUX_REFUS: { niveau: "WARNING", parametres: { seuilPct: 20, minTentatives: 10 } },
  PIC_SUSPECT: { niveau: "WARNING", parametres: { facteur: 3, minCaEuros: 100 } },
  VENTE_HORS_HORAIRES: { niveau: "INFO", parametres: { minVentes: 3 } },
  CONSOMMABLES: { niveau: "WARNING", parametres: { seuilTirages: 50 } },
} as const satisfies Partial<Record<TypeAlerte, { niveau: NiveauAlerte; parametres: Record<string, number> }>>;

export type TypeRegle = keyof typeof REGLES_DEFAUT;
export const TYPES_REGLES = Object.keys(REGLES_DEFAUT) as TypeRegle[];

export interface RegleEffective<T extends TypeRegle = TypeRegle> {
  actif: boolean;
  niveau: NiveauAlerte;
  parametres: { [K in keyof (typeof REGLES_DEFAUT)[T]["parametres"]]: number };
}

/** Règles en vigueur : défauts, puis règle globale, puis règle propre au lieu. */
export async function chargerRegles() {
  const lignes = await prisma.regleAlerte.findMany();
  return <T extends TypeRegle>(type: T, lieuId?: number | null): RegleEffective<T> => {
    const defaut = REGLES_DEFAUT[type];
    const globale = lignes.find((r) => r.type === type && r.lieuId === null);
    const locale = lieuId ? lignes.find((r) => r.type === type && r.lieuId === lieuId) : undefined;
    return {
      actif: locale?.actif ?? globale?.actif ?? true,
      niveau: locale?.niveau ?? globale?.niveau ?? defaut.niveau,
      parametres: {
        ...defaut.parametres,
        ...((globale?.parametres as object) ?? {}),
        ...((locale?.parametres as object) ?? {}),
      } as RegleEffective<T>["parametres"],
    };
  };
}
