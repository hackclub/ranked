const encoder = new TextEncoder();

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

// Every encryption secret goes through here so a deployment can't come up on
// a short value or on the placeholder text copied straight from .env.example
// — either would let anyone who has read this repository forge sessions.
export function requireSecret(name: string) {
  const secret = process.env[name];
  if (!secret || secret.trim().length < 32 || /^\s*replace[-_ ]with/i.test(secret)) {
    throw new Error(
      `${name} must be a random value of at least 32 characters (try: openssl rand -base64 48).`,
    );
  }
  return secret;
}

export async function aesGcmKey(material: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

// Output format is `<iv>.<ciphertext>`, both base64url — already stored in
// session cookies and the database, so it must stay stable.
export async function aesGcmEncrypt(key: CryptoKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function aesGcmDecrypt(key: CryptoKey, value: string, label: string) {
  const [iv, encrypted] = value.split(".");
  if (!iv || !encrypted) throw new Error(`Invalid encrypted ${label}.`);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) },
    key,
    fromBase64url(encrypted),
  );
  return new TextDecoder().decode(decrypted);
}
