import type { FastifyRequest } from "fastify";
import type { DialedDatabase } from "@dialed/db";
import * as dbSchema from "@dialed/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";

export interface Principal {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export interface AuthService {
  authenticate(request: FastifyRequest): Promise<Principal | null>;
  handler?: ReturnType<typeof toNodeHandler>;
}

export interface BetterAuthOptions {
  db: DialedDatabase;
  baseUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

export function createBetterAuthService(
  options: BetterAuthOptions,
): AuthService {
  const auth = betterAuth({
    baseURL: options.baseUrl,
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: dbSchema.users,
        session: dbSchema.sessions,
        account: dbSchema.accounts,
        verification: dbSchema.verifications,
      },
    }),
    socialProviders: {
      google: {
        clientId: options.googleClientId,
        clientSecret: options.googleClientSecret,
      },
    },
    trustedOrigins: [options.baseUrl],
  });

  return {
    handler: toNodeHandler(auth),
    async authenticate(request) {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (!session) return null;
      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
      };
    },
  };
}
