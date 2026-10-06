import { PrismaClient, type RefCategorie } from "@prisma/client";
import { genererCle } from "../src/lib/cleBorne.js";
import { initialiserReferentiel } from "../src/referentiel/initial.js";

const prisma = new PrismaClient();

async function main() {
  await initialiserReferentiel();

  // ─── Données de démo (dev uniquement) ───
  if (process.env.NODE_ENV === "production") return;

  const ref = (categorie: RefCategorie, code: string) =>
    prisma.refValeur.findUniqueOrThrow({ where: { categorie_code: { categorie, code } } }).then((r) => r.id);

  const lieu =
    (await prisma.lieu.findFirst({ where: { enseigne: "Camping Les Flots Bleus (démo)" } })) ??
    (await prisma.lieu.create({
      data: {
        raisonSociale: "SARL Flots Bleus",
        enseigne: "Camping Les Flots Bleus (démo)",
        ville: "Saint-Jean-de-Monts",
        codePostal: "85160",
        typeLieuId: await ref("TYPE_LIEU", "CAMPING"),
        sousTypeId: await ref("SOUS_TYPE_LIEU", "CAMPING_4_5"),
        saisonnalite: "SAISONNIER",
        zoneGeoId: await ref("ZONE_GEO", "LITTORAL"),
        capaciteAccueil: 1200,
        interieurExterieur: "EXTERIEUR",
        visibilite: 4,
      },
    }));

  const gamme = await prisma.gamme.findUniqueOrThrow({ where: { code: "MA_TROMBINE" } });
  const existante = await prisma.borne.findUnique({ where: { identifiant: "MT-0042" } });
  if (!existante) {
    const cle = genererCle();
    const borne = await prisma.borne.create({
      data: {
        identifiant: "MT-0042",
        gammeId: gamme.id,
        numeroSerie: "MT2026-0042",
        statut: "INSTALLEE",
        apiKeyHash: cle.hash,
        apiKeyPrefix: cle.prefixe,
        apiKeyCreeLe: new Date(),
      },
    });
    await prisma.affectationBorne.create({
      data: { borneId: borne.id, lieuId: lieu.id, debut: new Date("2026-04-01T00:00:00+02:00") },
    });
    console.log(`Borne de démo MT-0042 créée. Clé API (affichée une seule fois) :\n${cle.cle}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
