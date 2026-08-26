const encoder = new TextEncoder();

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function credentialKey() {
  const secret = process.env.HACKATIME_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("HACKATIME_TOKEN_ENCRYPTION_KEY must be at least 32 characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredential(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await credentialKey(),
    encoder.encode(value),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function decryptCredential(value: string) {
  const [iv, encrypted] = value.split(".");
  if (!iv || !encrypted) throw new Error("Invalid encrypted credential.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) },
    await credentialKey(),
    fromBase64url(encrypted),
  );
  return new TextDecoder().decode(decrypted);
}
