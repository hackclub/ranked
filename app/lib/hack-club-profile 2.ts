import type { HackClubAddress, HackClubIdentity } from "@/app/lib/hackclub";
import { getSql } from "@/db";

const encoder = new TextEncoder();
const MAX_IDENTITY_LENGTH = 320;
const MAX_ADDRESS_LENGTH = 500;

export type StoredHackClubProfile = {
  firstName: string;
  lastName: string;
  email: string;
  birthday: string | null;
  addresses: HackClubAddress[];
};

function bounded(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum
    ? value.trim()
    : "";
}

function validBirthday(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeAddresses(value: unknown): HackClubAddress[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 25)
    .filter(
      (address): address is HackClubAddress =>
        Boolean(
          address &&
            typeof address === "object" &&
            typeof address.id === "string" &&
            address.id.length > 0 &&
            address.id.length <= MAX_IDENTITY_LENGTH,
        ),
    )
    .map((address) => ({
      id: address.id,
      first_name: bounded(address.first_name, MAX_IDENTITY_LENGTH) || undefined,
      last_name: bounded(address.last_name, MAX_IDENTITY_LENGTH) || undefined,
      line_1: bounded(address.line_1, MAX_ADDRESS_LENGTH) || undefined,
      line_2: bounded(address.line_2, MAX_ADDRESS_LENGTH) || undefined,
      city: bounded(address.city, MAX_ADDRESS_LENGTH) || undefined,
      state: bounded(address.state, MAX_ADDRESS_LENGTH) || undefined,
      postal_code: bounded(address.postal_code, MAX_ADDRESS_LENGTH) || undefined,
      country: bounded(address.country, MAX_ADDRESS_LENGTH) || undefined,
      primary: address.primary === true,
    }));
}

export function profileFromIdentity(
  identity: HackClubIdentity,
  fallbackEmail: string,
): StoredHackClubProfile {
  const birthdayValue = bounded(
    identity.birthday ?? identity.birthdate,
    MAX_IDENTITY_LENGTH,
  );
  return {
    firstName: bounded(identity.first_name, MAX_IDENTITY_LENGTH),
    lastName: bounded(identity.last_name, MAX_IDENTITY_LENGTH),
    email: bounded(identity.primary_email ?? identity.email ?? fallbackEmail, MAX_IDENTITY_LENGTH)
      .toLowerCase(),
    birthday: validBirthday(birthdayValue) ? birthdayValue : null,
    addresses: normalizeAddresses(identity.addresses),
  };
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function profileKey() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must be at least 32 characters.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`ranked:hca-profile:v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptHackClubProfile(profile: StoredHackClubProfile) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await profileKey(),
    encoder.encode(JSON.stringify(profile)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

async function decryptHackClubProfile(value: string) {
  const [iv, encrypted] = value.split(".");
  if (!iv || !encrypted) throw new Error("Invalid encrypted HCA profile.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) },
    await profileKey(),
    fromBase64url(encrypted),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as StoredHackClubProfile;
}

export async function getHackClubProfile(userId: string) {
  const rows = await getSql()`SELECT profile_encrypted AS "profileEncrypted"
    FROM hack_club_profiles WHERE user_id=${userId} LIMIT 1`;
  const encrypted = rows[0]?.profileEncrypted as string | undefined;
  if (!encrypted) return null;
  try {
    return await decryptHackClubProfile(encrypted);
  } catch (error) {
    console.error("Could not decrypt HCA submission profile", error);
    return null;
  }
}

export function publicAddressLabel(address: HackClubAddress) {
  return [address.line_1, address.city, address.state, address.country]
    .filter(Boolean)
    .join(", ");
}

export function completeSubmissionAddress(
  profile: StoredHackClubProfile,
  address: HackClubAddress,
) {
  return Boolean(
    address.id &&
      (address.first_name || profile.firstName) &&
      (address.last_name || profile.lastName) &&
      address.line_1 &&
      address.city &&
      address.country &&
      address.postal_code,
  );
}

export function completeSubmissionProfile(profile: StoredHackClubProfile | null) {
  return Boolean(
    profile?.email &&
      profile.birthday &&
      profile.addresses.some((address) => completeSubmissionAddress(profile, address)),
  );
}
