import { sql } from "@hop/shared/server/db";
import { createProofRoute } from "@hop/shared/server/proofs";
import { APP_ROLE } from "@/lib/app";

export const dynamic = "force-dynamic";

/** GET /api/proofs/<id> → a proof image, only for a job dispatched to the signed-in rep. */
export const GET = createProofRoute(APP_ROLE, async (user, jobId) => {
  const rows = (await sql()`SELECT 1 FROM portal_jobs WHERE id = ${jobId} AND rep_id = ${user.id}`) as unknown[];
  return rows.length > 0;
});
