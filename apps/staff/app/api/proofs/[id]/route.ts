import { sql } from "@hop/shared/server/db";
import { createProofRoute } from "@hop/shared/server/proofs";
import { APP_ROLE } from "@/lib/app";

export const dynamic = "force-dynamic";

/** GET /api/proofs/<id> → a proof image, only on the signed-in member's own completed request. */
export const GET = createProofRoute(APP_ROLE, async (user, jobId) => {
  const rows = (await sql()`
    SELECT 1 FROM portal_jobs j JOIN portal_requests r ON r.job_id = j.id
    WHERE j.id = ${jobId} AND r.member_id = ${user.id} AND j.status = 'completed'
  `) as unknown[];
  return rows.length > 0;
});
