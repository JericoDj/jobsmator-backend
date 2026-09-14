import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { env } from "@/lib/env";

if (getApps().length === 0) {
  const serviceAccount = JSON.parse(Buffer.from(env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8"));
  initializeApp({ credential: cert(serviceAccount), storageBucket: env.FIREBASE_STORAGE_BUCKET });
}

export const firebaseAuth = getAuth();
export const bucket = getStorage().bucket();
