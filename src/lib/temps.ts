import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

export const FUSEAU_METIER = "Europe/Paris";

/** Décalage (en minutes) porté par un horodatage RFC 3339 : "Z" → 0, "+02:00" → 120. */
export function offsetMinutes(horodatage: string): number {
  const m = /(Z|([+-])(\d{2}):(\d{2}))$/.exec(horodatage);
  if (!m || m[1] === "Z") return 0;
  const minutes = Number(m[3]) * 60 + Number(m[4]);
  return m[2] === "-" ? -minutes : minutes;
}

/**
 * Jour et heure locaux (Europe/Paris) d'un instant.
 * Le jour est renvoyé à minuit UTC, format attendu par Prisma pour une colonne @db.Date.
 */
export function jourEtHeureLocaux(instant: Date): { jour: Date; heure: number } {
  const local = new TZDate(instant, FUSEAU_METIER);
  return {
    jour: new Date(`${format(local, "yyyy-MM-dd")}T00:00:00Z`),
    heure: local.getHours(),
  };
}
