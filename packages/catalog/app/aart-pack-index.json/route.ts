import { catalogDocument } from "../../lib/catalog";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(catalogDocument, {
    headers: {
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
    },
  });
}
