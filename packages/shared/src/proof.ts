/**
 * Proof photos and signatures are private files (portal_proof_files). A job stores a reference
 * like "proof:<uuid>", never a public URL. proofSrc() turns it into this app's own
 * /api/proofs/<uuid>, which only answers a signed-in user who may see that job.
 */
export const PROOF_REF = /^proof:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function proofSrc(ref: string): string {
  const m = PROOF_REF.exec(ref);
  return m ? `/api/proofs/${m[1]}` : "";
}
