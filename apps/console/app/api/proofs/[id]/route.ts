import { createProofRoute } from "@hop/shared/server/proofs";
import { APP_ROLE } from "@/lib/app";

export const dynamic = "force-dynamic";

/** GET /api/proofs/<id> → a proof image. Console users see every job, so any signed-in console user. */
export const GET = createProofRoute(APP_ROLE, async () => true);
