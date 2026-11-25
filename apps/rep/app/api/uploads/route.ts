import { z } from "zod";
import { withAuth } from "@hop/shared/server/auth";
import { json, readJson, zodMessage } from "@hop/shared/server/db";
import { saveProofFile } from "@hop/shared/server/proofs";
import { getJob } from "@hop/shared/server/store";
import { APP_ROLE } from "@/lib/app";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 2_000_000; // 2 MB decoded

const uploadSchema = z.object({
  dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Send a PNG, JPEG, or WEBP image"),
  kind: z.enum(["photo", "signature"]),
  jobId: z.string().min(1).max(40)
});

/**
 * POST /api/uploads { dataUrl, kind: "photo" | "signature", jobId } -> { url: "proof:<uuid>" }
 * The job must be the signed-in rep's (404 otherwise) and still taking proof.
 * The image is stored privately in portal_proof_files; there is no public URL. The reference is
 * then saved on the job, and each app serves it at /api/proofs/<uuid> to people allowed to see it.
 */
export const POST = withAuth(APP_ROLE, async (request, user) => {
  const parsed = uploadSchema.safeParse(await readJson(request, 2_900_000));
  if (!parsed.success) return json({ error: zodMessage(parsed.error) }, 400);
  const { dataUrl, kind, jobId } = parsed.data;

  const job = await getJob(jobId, { repId: user.id });
  if (!job) return json({ error: "Job not found" }, 404);
  if (job.status === "completed" || job.status === "declined" || job.status === "offer") {
    return json({ error: "This job isn't taking proof right now." }, 409);
  }

  const [meta, b64] = dataUrl.split(",");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) return json({ error: "Image is over 2 MB. Try again." }, 413);

  const type = meta.slice(5, meta.indexOf(";"));
  return json({ url: await saveProofFile(job.id, kind, type, bytes, user.id) });
});
