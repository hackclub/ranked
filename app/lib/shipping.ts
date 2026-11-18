import { aesGcmEncrypt, aesGcmKey, requireSecret } from "@/app/lib/aes-gcm";

export type ShippingAddress = {
  name: string;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  hcaAddressId: string;
};

// What actually sits in shop_orders.shipping: the address as AES-GCM
// ciphertext, plus which secret it was encrypted under so it can still be
// read after a deployment starts using a dedicated key.
export type StoredShipping = { v: 1; key: "shipping" | "session"; enc: string };

// A player's name and home address are the most sensitive thing this database
// holds, so an order never stores them in the clear — a leaked backup or a
// read-only database credential shows ciphertext. Nothing in the app reads
// them back; fulfilment decrypts with `npm run shop:orders`
// (scripts/shop-shipping.mjs), which must derive its key exactly as this does.
function shippingSecret(): { key: StoredShipping["key"]; secret: string } {
  // A dedicated key is preferred: rotating AUTH_SESSION_SECRET (which only
  // signs people out) would otherwise also make open orders unreadable.
  if (process.env.SHIPPING_ENCRYPTION_KEY) {
    return { key: "shipping", secret: requireSecret("SHIPPING_ENCRYPTION_KEY") };
  }
  return { key: "session", secret: requireSecret("AUTH_SESSION_SECRET") };
}

export async function encryptShipping(shipping: ShippingAddress): Promise<StoredShipping> {
  const { key, secret } = shippingSecret();
  const cryptoKey = await aesGcmKey(`ranked:shop-shipping:v1:${secret}`);
  return { v: 1, key, enc: await aesGcmEncrypt(cryptoKey, JSON.stringify(shipping)) };
}
