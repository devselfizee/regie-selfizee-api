import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";

const KEYCLOAK_URL = (process.env.KEYCLOAK_URL || "https://plateform-auth.orkessidev.com").replace(/\/+$/, "");
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "konitys";
// Realm des clients de la Régie (option 2 du 20/11/2026) : comptes gérés par la Régie, séparés des salariés.
// Vide : seuls les salariés (realm konitys) peuvent se connecter.
const KEYCLOAK_REGIE_REALM = (process.env.KEYCLOAK_REGIE_REALM || "").trim();

/** Realm d'où vient le jeton : salarié Konitys, ou client de la Régie */
export type Realm = "konitys" | "regie";

const issuer = (realm: string) => `${KEYCLOAK_URL}/realms/${realm}`;

const clientJwks = (realm: string) =>
  jwksRsa({
    jwksUri: `${issuer(realm)}/protocol/openid-connect/certs`,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 600000, // 10 min
  });

// Un jeu de clés par realm accepté, choisi d'après l'émetteur du jeton
const realms = new Map<string, { realm: Realm; jwks: jwksRsa.JwksClient }>([[issuer(KEYCLOAK_REALM), { realm: "konitys", jwks: clientJwks(KEYCLOAK_REALM) }]]);
if (KEYCLOAK_REGIE_REALM && KEYCLOAK_REGIE_REALM !== KEYCLOAK_REALM) {
  realms.set(issuer(KEYCLOAK_REGIE_REALM), { realm: "regie", jwks: clientJwks(KEYCLOAK_REGIE_REALM) });
}

/** Realm correspondant à l'émetteur d'un jeton, ou null s'il n'est pas accepté */
export function realmDeLEmetteur(iss: unknown, acceptes: ReadonlyMap<string, { realm: Realm }> = realms): Realm | null {
  return typeof iss === "string" ? (acceptes.get(iss)?.realm ?? null) : null;
}

export interface AuthRequest extends Request {
  user?: {
    sub: string;
    email?: string;
    preferred_username?: string;
    given_name?: string;
    family_name?: string;
    phone_number?: string;
    realm_access?: { roles: string[] };
    resource_access?: Record<string, { roles?: string[] }>;
  };
  /** Realm du jeton vérifié (absent sans Keycloak, en dev : salarié) */
  realm?: Realm;
}

/** Vrai si la requête vient d'un compte client de la Régie (realm « regie ») */
export const estCompteRegie = (req: Request) => (req as AuthRequest).realm === "regie";

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  // En dev, si pas de KEYCLOAK_URL configuré, on skip l'auth
  if (!process.env.KEYCLOAK_URL && process.env.NODE_ENV !== "production") {
    // Dev / tests : X-Dev-Compte: regie simule un compte client de la Régie
    if (req.header("x-dev-compte") === "regie") req.realm = "regie";
    return next();
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token manquant" });
  }

  const token = authHeader.slice(7);
  // L'émetteur choisit les clés : un jeton d'un autre realm (ou d'un autre Keycloak) est refusé
  const iss = (jwt.decode(token) as { iss?: unknown } | null)?.iss;
  const source = typeof iss === "string" ? realms.get(iss) : undefined;
  if (!source) return res.status(401).json({ error: "Token invalide" });

  jwt.verify(
    token,
    (header, callback) => {
      source.jwks.getSigningKey(header.kid, (err, key) => (err ? callback(err) : callback(null, key?.getPublicKey())));
    },
    { issuer: iss as string, algorithms: ["RS256"] },
    (err, decoded) => {
      if (err) {
        console.error("JWT verification failed:", err.message);
        return res.status(401).json({ error: "Token invalide" });
      }
      req.user = decoded as AuthRequest["user"];
      req.realm = source.realm;
      next();
    }
  );
}
