import { aesGcmDecrypt, aesGcmEncrypt, aesGcmKey } from "@/app/lib/aes-gcm";

async function credentialKey() {
  const secret = process.env.HACKATIME_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("HACKATIME_TOKEN_ENCRYPTION_KEY must be at least 32 characters.");
  }
  return aesGcmKey(secret);
}

export async function encryptCredential(value: string) {
  return aesGcmEncrypt(await credentialKey(), value);
}

export async function decryptCredential(value: string) {
  return aesGcmDecrypt(await credentialKey(), value, "credential");
}
