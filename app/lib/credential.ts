import { aesGcmDecrypt, aesGcmEncrypt, aesGcmKey, requireSecret } from "@/app/lib/aes-gcm";

async function credentialKey() {
  return aesGcmKey(requireSecret("HACKATIME_TOKEN_ENCRYPTION_KEY"));
}

export async function encryptCredential(value: string) {
  return aesGcmEncrypt(await credentialKey(), value);
}

export async function decryptCredential(value: string) {
  return aesGcmDecrypt(await credentialKey(), value, "credential");
}
