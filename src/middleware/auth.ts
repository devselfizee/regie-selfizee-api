import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";

const KEYCLOAK_URL =
  process.env.KEYCLOAK_URL || "https://plateformdev-auth.orkessi.com";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "konitys";

const jwksClient = jwksRsa({
  jwksUri: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000, // 10 min
});

function getKey(
  header: jwt.JwtHeader,
  callback: (err: Error | null, key?: string) => void
) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export interface AuthRequest extends Request {
  user?: {
    sub: string;
    email?: string;
    preferred_username?: string;
    given_name?: string;
    family_name?: string;
    realm_access?: { roles: string[] };
  };
}

export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  // En dev, si pas de KEYCLOAK_URL configuré, on skip l'auth
  if (!process.env.KEYCLOAK_URL && process.env.NODE_ENV !== "production") {
    return next();
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token manquant" });
  }

  const token = authHeader.slice(7);

  jwt.verify(
    token,
    getKey,
    {
      issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) {
        console.error("JWT verification failed:", err.message);
        return res.status(401).json({ error: "Token invalide" });
      }
      req.user = decoded as AuthRequest["user"];
      next();
    }
  );
}
