import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asynchrone, HttpError } from "../lib/http.js";
import { verifierAccesLieu, type UtilisateurRequest } from "../middleware/utilisateur.js";
import { requirePerm } from "../middleware/permissions.js";
import { heureSchema, instantsDe } from "../config-evenement/reglages.js";
import { jourIso } from "../config-evenement/programmeBorne.js";
import { etatDuZip } from "../config-evenement/zipBorne.js";
import { cheminZipBooth, deposerZipBooth, maxZipBooth, selectionZipBooth, versionServie } from "../config-evenement/zipBooth.js";
import { cheminAbsolu, existe } from "../lib/stockage.js";

// Créneaux d'événements booth programmés sur un lieu (avenant de l'équipe borne du 18/11/2026) : dans l'onglet
// Configuration, à côté des événements Régie. La Régie ne vérifie pas le code auprès de booth (demande de
// l'exploitant) : seulement sa forme. Le programme de la borne (programmeBorne.ts) le transmet tel quel. Montée sous
// /api/lieux ; mêmes droits que les événements Régie.
// Avenant du 24/11/2026 : « événement sur mesure ». Sur un créneau, l'exploitant dépose le zip de l'événement booth
// retouché ; la Régie le sert aux bornes (zipBooth.ts). Le zip est celui du code : tous ses créneaux, sur tous les lieux.
export const evenementsBoothRouter = Router();
const voir = requirePerm("evenements.view");
const modifier = requirePerm("evenements.edit");

/** Code booth : 3 à 8 lettres ou chiffres, mis en majuscules (la borne compare en majuscules). */
const codeBooth = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,8}$/, "Code attendu : 3 à 8 lettres ou chiffres");
const saisieSchema = z.object({
  code: codeBooth,
  nom: z.string().trim().max(80).nullable().default(null).transform((n) => n || null),
  dateDebut: z.iso.date(),
  dateFin: z.iso.date(),
  heureDebut: heureSchema.nullable().default(null),
  heureFin: heureSchema.nullable().default(null),
});
function lireSaisie(corps: unknown) {
  const saisie = saisieSchema.parse(corps);
  const { debut, fin } = instantsDe(saisie);
  if (fin <= debut) throw new HttpError(400, "DATES", "La fin est avant le début.");
  return saisie;
}
/** Jour « AAAA-MM-JJ » → valeur d'une colonne @db.Date. */
const enDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

type Creneau = { code: string; nom: string | null; dateDebut: Date; dateFin: Date; heureDebut: string | null; heureFin: string | null };
const jourFr = (d: Date) => jourIso(d).split("-").reverse().join("/");
/** « le 26/11/2026 de 20:00 à 22:00 », « du 20/11/2026 20:00 au 21/11/2026 06:00 ». */
function quand(c: Creneau) {
  if (c.dateDebut.getTime() === c.dateFin.getTime()) {
    return `le ${jourFr(c.dateDebut)}${c.heureDebut || c.heureFin ? ` de ${c.heureDebut ?? "00:00"} à ${c.heureFin ?? "24:00"}` : ""}`;
  }
  return `du ${jourFr(c.dateDebut)}${c.heureDebut ? ` ${c.heureDebut}` : ""} au ${jourFr(c.dateFin)}${c.heureFin ? ` ${c.heureFin}` : ""}`;
}

/**
 * Un seul événement booth à la fois sur un lieu (retour du 25/11/2026) : refuse un créneau qui en chevauche un autre du
 * lieu, quel que soit son code (deux fois le même créneau, ou deux événements booth en même temps). Se suivre est permis
 * (l'un finit à 21:00, l'autre commence à 21:00). Le même code à d'autres dates, et un booth pendant un événement de la
 * Régie, restent permis (celui qui a commencé le plus tard tourne).
 */
async function verifierCreneauLibre(lieuId: number, s: ReturnType<typeof lireSaisie>, sauf?: number) {
  const { debut, fin } = instantsDe(s);
  // Les créneaux dont les jours touchent la saisie, puis la comparaison à la minute
  const voisins = await prisma.evenementBooth.findMany({
    where: { lieuId, ...(sauf ? { id: { not: sauf } } : {}), dateDebut: { lte: enDate(s.dateFin) }, dateFin: { gte: enDate(s.dateDebut) } },
    select: { code: true, nom: true, dateDebut: true, dateFin: true, heureDebut: true, heureFin: true },
    orderBy: { dateDebut: "asc" },
  });
  const occupe = voisins.find((v) => {
    const i = instantsDe({ dateDebut: jourIso(v.dateDebut), dateFin: jourIso(v.dateFin), heureDebut: v.heureDebut, heureFin: v.heureFin });
    return debut < i.fin && i.debut < fin;
  });
  if (occupe) {
    const qui = occupe.nom ? `« ${occupe.nom} » (${occupe.code})` : `le code ${occupe.code}`;
    throw new HttpError(409, "CRENEAU_OCCUPE", `Ce créneau chevauche ${qui}, programmé ${quand(occupe)} : un seul événement booth à la fois sur un lieu.`);
  }
}

const selection = { id: true, code: true, nom: true, dateDebut: true, dateFin: true, heureDebut: true, heureFin: true, createdAt: true, updatedAt: true } as const;
type Ligne = { id: number; code: string; nom: string | null; dateDebut: Date; dateFin: Date; heureDebut: string | null; heureFin: string | null; createdAt: Date; updatedAt: Date };
const versJson = (e: Ligne) => ({
  id: e.id, code: e.code, nom: e.nom, origine: "booth" as const,
  dateDebut: jourIso(e.dateDebut), dateFin: jourIso(e.dateFin), heureDebut: e.heureDebut, heureFin: e.heureFin,
  creeLe: e.createdAt, modifieLe: e.updatedAt,
});

async function creneauDe(lieuId: number, bid: number) {
  const e = await prisma.evenementBooth.findFirst({ where: { id: bid, lieuId }, select: selection });
  if (!e) throw new HttpError(404, "INTROUVABLE", "Créneau booth introuvable");
  return e;
}

/**
 * Les créneaux avec l'état du zip sur mesure de leur code (null : jamais déposé) et le nombre d'autres lieux où ce code
 * est programmé (le zip y est servi aussi). Seulement un nombre : ces lieux peuvent être hors du périmètre de l'utilisateur.
 */
async function avecZip(lieuId: number, lignes: Ligne[]) {
  const codes = [...new Set(lignes.map((e) => e.code))];
  const [zips, ailleurs] = codes.length
    ? await Promise.all([
        prisma.zipBooth.findMany({ where: { code: { in: codes } }, select: { ...selectionZipBooth, nomFichier: true, deposePar: { select: { prenom: true, nom: true } } } }),
        prisma.evenementBooth.findMany({ where: { code: { in: codes }, lieuId: { not: lieuId } }, select: { code: true, lieuId: true }, distinct: ["code", "lieuId"] }),
      ])
    : [[], []];
  const etats = new Map(
    await Promise.all(
      zips
        .filter((z) => z.version > 0)
        .map(async (z) => [
          z.code,
          {
            actif: versionServie(z) > 0,
            version: z.version,
            publieLe: z.publieeLe,
            taille: z.zipTaille,
            sha256: z.zipSha256,
            nomFichier: z.nomFichier,
            deposePar: z.deposePar ? `${z.deposePar.prenom} ${z.deposePar.nom}`.trim() : null,
            // complete : servi tel quel ; obsolete : fichier disparu du stockage, à redéposer
            etat: await etatDuZip(z),
          },
        ] as const)
    )
  );
  return lignes.map((e) => ({ ...versJson(e), zip: etats.get(e.code) ?? null, autresLieux: ailleurs.filter((a) => a.code === e.code).length }));
}

// GET /api/lieux/:id/evenements-booth — les créneaux du lieu, du plus récent au plus ancien, avec leur zip sur mesure
evenementsBoothRouter.get(
  "/:id/evenements-booth",
  voir,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const liste = await prisma.evenementBooth.findMany({ where: { lieuId }, select: selection, orderBy: [{ dateDebut: "desc" }, { id: "desc" }] });
    res.json(await avecZip(lieuId, liste));
  })
);

// POST /api/lieux/:id/evenements-booth { code, nom?, dateDebut, dateFin, heureDebut?, heureFin? } — programme un code booth
evenementsBoothRouter.post(
  "/:id/evenements-booth",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    if (!(await prisma.lieu.findUnique({ where: { id: lieuId }, select: { id: true } }))) throw new HttpError(404, "INTROUVABLE");
    const s = lireSaisie(req.body);
    await verifierCreneauLibre(lieuId, s);
    const e = await prisma.evenementBooth.create({
      data: { lieuId, code: s.code, nom: s.nom, dateDebut: enDate(s.dateDebut), dateFin: enDate(s.dateFin), heureDebut: s.heureDebut, heureFin: s.heureFin, creeParId: req.utilisateur?.id ?? null },
      select: selection,
    });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "evenement_booth", entiteId: String(e.id), action: "CREATION", apres: { lieuId, ...s } },
    });
    res.status(201).json((await avecZip(lieuId, [e]))[0]);
  })
);

// PUT /api/lieux/:id/evenements-booth/:bid — modifie le code, le nom ou les dates
evenementsBoothRouter.put(
  "/:id/evenements-booth/:bid",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const avant = await creneauDe(lieuId, Number(req.params.bid));
    const s = lireSaisie(req.body);
    await verifierCreneauLibre(lieuId, s, avant.id);
    const e = await prisma.evenementBooth.update({
      where: { id: avant.id },
      data: { code: s.code, nom: s.nom, dateDebut: enDate(s.dateDebut), dateFin: enDate(s.dateFin), heureDebut: s.heureDebut, heureFin: s.heureFin },
      select: selection,
    });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "evenement_booth", entiteId: String(e.id), action: "MODIFICATION", avant: versJson(avant), apres: { lieuId, ...s } },
    });
    res.json((await avecZip(lieuId, [e]))[0]);
  })
);

// DELETE /api/lieux/:id/evenements-booth/:bid — retire le créneau (la borne reviendra au programme au prochain appel)
evenementsBoothRouter.delete(
  "/:id/evenements-booth/:bid",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const e = await creneauDe(lieuId, Number(req.params.bid));
    await prisma.evenementBooth.delete({ where: { id: e.id } });
    await prisma.auditLog.create({
      data: { userId: req.utilisateur?.id ?? null, entite: "evenement_booth", entiteId: String(e.id), action: "SUPPRESSION", avant: versJson(e) },
    });
    res.status(204).end();
  })
);

// ─── Événement sur mesure : le zip déposé (avenant du 24/11/2026) ───

/** Types acceptés pour le corps du dépôt (Windows annonce application/x-zip-compressed). */
const TYPES_ZIP = ["application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream"];
const mo = (octets: number) => `${Math.round(octets / 1024 / 1024)} Mo`;

/** Nom du fichier envoyé (en-tête X-Nom-Fichier, encodé par le front) : pour l'affichage seulement. */
function nomFichierDe(entete: string | undefined): string | null {
  if (!entete) return null;
  let nom: string;
  try {
    nom = decodeURIComponent(entete);
  } catch {
    nom = entete;
  }
  // Seulement le nom, sans chemin (« C:\fakepath\… » ou « dossier/… »), sans caractère de contrôle
  nom = (nom.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return nom ? nom.slice(0, 255) : null;
}

// POST /api/lieux/:id/evenements-booth/:bid/zip — dépose le zip de l'événement (corps : le fichier zip lui-même,
// 100 Mo au plus ; X-Nom-Fichier : son nom). Contrôle le code du config.json, enregistre la version suivante et coche
// « sur mesure » : les bornes l'installent seules. Le zip vaut pour le code, sur tous ses créneaux et tous ses lieux.
evenementsBoothRouter.post(
  "/:id/evenements-booth/:bid/zip",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const e = await creneauDe(lieuId, Number(req.params.bid));
    if (!req.is(TYPES_ZIP)) throw new HttpError(415, "TYPE_ZIP", "Envoyez le fichier zip lui-même (Content-Type: application/zip).");
    // Refus avant de lire le corps quand la taille annoncée suffit à le dire (le reste est compté pendant l'écriture)
    if (Number(req.headers["content-length"]) > maxZipBooth()) throw new HttpError(413, "ZIP_TROP_GROS", `Le zip dépasse ${mo(maxZipBooth())}.`);
    // Un code qui est aussi celui d'un événement Régie : la borne de ce lieu chargerait l'événement Régie
    if (await prisma.configEvenement.findUnique({ where: { code: e.code }, select: { id: true } })) {
      throw new HttpError(409, "CODE_REGIE", `${e.code} est aussi le code d'un événement de la Régie : changez le code du créneau.`);
    }
    await deposerZipBooth(req, { code: e.code, nomFichier: nomFichierDe(req.get("X-Nom-Fichier")), deposeParId: req.utilisateur?.id ?? null, lieuId, creneauId: e.id });
    res.status(201).json((await avecZip(lieuId, [e]))[0]);
  })
);

// PUT /api/lieux/:id/evenements-booth/:bid/sur-mesure { actif } — la case « Événement sur mesure ». Décochée : le
// programme renvoie version 0, la borne reprend la version de booth. Recochée : le dernier zip déposé est resservi,
// avec son numéro (même contenu). Cocher sans zip déposé est refusé.
evenementsBoothRouter.put(
  "/:id/evenements-booth/:bid/sur-mesure",
  modifier,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const e = await creneauDe(lieuId, Number(req.params.bid));
    const { actif } = z.object({ actif: z.boolean() }).parse(req.body);
    const zb = await prisma.zipBooth.findUnique({ where: { code: e.code }, select: selectionZipBooth });
    if (actif) {
      if (!zb || zb.version === 0) throw new HttpError(400, "PAS_DE_ZIP", "Déposez d'abord le zip de l'événement.");
      if ((await etatDuZip(zb)) !== "complete") throw new HttpError(400, "ZIP_ABSENT", "Le dernier zip déposé n'est plus disponible : déposez-le à nouveau.");
    }
    if (zb && zb.actif !== actif) {
      await prisma.$transaction([
        prisma.zipBooth.update({ where: { code: e.code }, data: { actif } }),
        prisma.auditLog.create({
          data: {
            userId: req.utilisateur?.id ?? null, entite: "zip_booth", entiteId: e.code, action: actif ? "ACTIVATION" : "RETRAIT",
            avant: { actif: zb.actif }, apres: { code: e.code, version: zb.version, actif, lieuId, creneauId: e.id },
          },
        }),
      ]);
    }
    res.json((await avecZip(lieuId, [e]))[0]);
  })
);

// GET /api/lieux/:id/evenements-booth/:bid/zip — le dernier zip déposé pour ce code (pour repartir de lui)
evenementsBoothRouter.get(
  "/:id/evenements-booth/:bid/zip",
  voir,
  asynchrone<UtilisateurRequest>(async (req, res) => {
    const lieuId = Number(req.params.id);
    await verifierAccesLieu(req.utilisateur, lieuId);
    const e = await creneauDe(lieuId, Number(req.params.bid));
    const zb = await prisma.zipBooth.findUnique({ where: { code: e.code }, select: { version: true } });
    if (!zb || zb.version === 0 || !(await existe(cheminZipBooth(e.code, zb.version)))) throw new HttpError(404, "INTROUVABLE", "Aucun zip déposé pour ce code");
    res.setHeader("Content-Disposition", `attachment; filename="${e.code}-v${zb.version}.zip"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(cheminAbsolu(cheminZipBooth(e.code, zb.version)), { headers: { "Content-Type": "application/zip" }, etag: false, lastModified: false });
  })
);
