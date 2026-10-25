import { aesGcmDecrypt, aesGcmEncrypt, aesGcmKey } from "@/app/lib/aes-gcm";
import type { HackClubAddress, HackClubIdentity } from "@/app/lib/hackclub";
import { getSql } from "@/db";

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

async function profileKey() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must be at least 32 characters.");
  }
  return aesGcmKey(`ranked:hca-profile:v1:${secret}`);
}

export async function encryptHackClubProfile(profile: StoredHackClubProfile) {
  return aesGcmEncrypt(await profileKey(), JSON.stringify(profile));
}

async function decryptHackClubProfile(value: string) {
  const decrypted = await aesGcmDecrypt(await profileKey(), value, "HCA profile");
  return JSON.parse(decrypted) as StoredHackClubProfile;
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

// The submission flow never lets a player choose between addresses — it
// always ships to whichever one HCA has marked primary, falling back to the
// first complete address on file if none is marked (rare, but an account
// shouldn't be unable to submit just because HCA never got a primary flag).
export function resolvePrimaryAddress(
  profile: StoredHackClubProfile | null,
): HackClubAddress | null {
  if (!profile) return null;
  const complete = profile.addresses.filter((address) =>
    completeSubmissionAddress(profile, address),
  );
  return complete.find((address) => address.primary) ?? complete[0] ?? null;
}

// Unlike the match-submission flow, the shop DOES let a player choose which
// address a physical prize ships to — H-Bucks purchases are a deliberate,
// one-off decision (dorm vs. home, etc.), not an automatic per-match action.
// Only complete addresses are ever offered; an incomplete one can't actually
// be shipped to, so surfacing it as a pickable option would just be a dead end.
export function completeSubmissionAddresses(
  profile: StoredHackClubProfile | null,
): HackClubAddress[] {
  if (!profile) return [];
  return profile.addresses.filter((address) =>
    completeSubmissionAddress(profile, address),
  );
}

// HCA addresses have no human-readable label of their own — build one from
// whatever's on file so a dropdown option reads as an actual place ("123
// Main St, Springfield") instead of an opaque id.
export function addressLabel(address: HackClubAddress): string {
  const parts = [address.line_1, address.city, address.state].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? parts.join(", ") : "Address on file";
}
