import "server-only";
import { PROOF_REF } from "../proof";
import type { PortalUser, Role } from "../types";
import { withAuth } from "./auth";
import { json, sql } from "./db";

/** Saves one proof image privately and returns its reference ("proof:<uuid>") for the job. */
export async function saveProofFile(jobId: string, kind: "photo" | "signature", contentType: string, bytes: Buffer, userId: string): Promise<string> {
  const rows = (await sql()`
    INSERT INTO portal_proof_files (job_id, kind, content_type, bytes, uploaded_by)
    VALUES (${jobId}, ${kind}, ${contentType}, ${"\\x" + bytes.toString("hex")}::bytea, ${userId})
    RETURNING id
  `) as { id: string }[];
  return `proof:${rows[0].id}`;
}

/** True when every "proof:<uuid>" reference is a file uploaded for this job (not another job's). */
export async function proofsBelongToJob(refs: string[], jobId: string): Promise<boolean> {
  const ids = [...new Set(refs.map((r) => PROOF_REF.exec(r)?.[1]).filter((x): x is string => !!x))];
  if (ids.length !== new Set(refs).size) return false;
  if (!ids.length) return true;
  const rows = (await sql()`SELECT COUNT(*)::int AS n FROM portal_proof_files WHERE id = ANY(${ids}::uuid[]) AND job_id = ${jobId}`) as { n: number }[];
  return rows[0]?.n === ids.length;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * GET /api/proofs/<id> for one app. `canSee(user, jobId)` is that app's rule (rep: own jobs,
 * console: all, staff: own completed requests). Anything else, missing or not allowed, is a 404,
 * so the answer never confirms that a file exists. Never cached by shared caches.
 */
export function createProofRoute(role: Role, canSee: (user: PortalUser, jobId: string) => Promise<boolean>) {
  return withAuth<{ params: Promise<{ id: string }> }>(role, async (_request, user, ctx) => {
    const { id } = await ctx.params;
    if (!UUID.test(id)) return json({ error: "Not found" }, 404);
    const rows = (await sql()`
      SELECT job_id, content_type, encode(bytes, 'base64') AS b64 FROM portal_proof_files WHERE id = ${id}
    `) as { job_id: string; content_type: string; b64: string }[];
    const f = rows[0];
    if (!f || !(await canSee(user, f.job_id))) return json({ error: "Not found" }, 404);
    return new Response(Buffer.from(f.b64, "base64"), {
      headers: {
        "Content-Type": f.content_type,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox"
      }
    });
  });
}
