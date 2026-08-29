# Security Advisory Register

Dialed's production dependency gate rejects all high and critical advisories:

```bash
pnpm audit --prod --audit-level=high
```

Moderate advisories are accepted only when their production exposure and follow-up are documented below.

| Reviewed   | Advisory                                                                                      | Dependency path                                                                           | Runtime inclusion                                                                                                                                          | Exposure                                                                                                                               | Follow-up                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-28 | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) (`esbuild <=0.24.2`) | `better-auth > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` | The path is tooling-only and must be absent from the pruned API runtime image; the container gate verifies that `node_modules/drizzle-kit` is not present. | The advisory applies to an esbuild development server. Dialed does not run Drizzle Kit or an esbuild development server in production. | Track the Better Auth/Drizzle Kit dependency graph and remove this exception once the legacy loader path is eliminated upstream. |
