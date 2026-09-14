import { bucket } from "./auth";

/** Short-lived URL the n8n engine can fetch without Firebase credentials. */
export async function signedResumeUrl(storagePath: string, ttlMs = 15 * 60 * 1000): Promise<string> {
  const [url] = await bucket.file(storagePath).getSignedUrl({ action: "read", expires: Date.now() + ttlMs });
  return url;
}

export async function deleteObject(storagePath: string) {
  await bucket.file(storagePath).delete({ ignoreNotFound: true });
}
