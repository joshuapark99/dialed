export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    status: "ok",
    revision: process.env.APP_REVISION ?? "development",
  });
}
