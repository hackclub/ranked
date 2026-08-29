import physicalShopItemsData from "@/data/shop-items.json";

export const AVATAR_COUNTS = {
  shape: 8,
  limbs: 8,
  eye: 7,
  hair: 5,
  mouth: 6,
} as const;

export type AvatarPartName = keyof typeof AVATAR_COUNTS;
export const AVATAR_PARTS = Object.keys(AVATAR_COUNTS) as AvatarPartName[];

// A starter value normally counts as free the instant it's <= AVATAR_COUNTS[part]
// (see isOwnedOrStarterValue below). Listing one here pulls it out of that free
// pool instead — it now has to be bought as the matching PREMIUM_AVATAR_ITEMS
// entry, same as any value past the starter range.
const PAYWALLED_STARTER_VALUES: Partial<Record<AvatarPartName, number[]>> = {
  limbs: [3],
};

export function isPaywalledStarterValue(part: AvatarPartName, value: number): boolean {
  return PAYWALLED_STARTER_VALUES[part]?.includes(value) ?? false;
}

export type PremiumAvatarItem = {
  id: string;
  part: AvatarPartName;
  value: number;
  name: string;
  cost: number;
  // False delists an item from the Shop and the Wardrobe's "locked, buy in
  // Shop" prompt without touching anyone who already bought it — the id and
  // value stay valid so their purchase and equipped look keep working.
  listed?: boolean;
};

// Values continue numbering past each part's starter range (AVATAR_COUNTS) so they
// never collide with the free onboarding pool. Assets are placeholders — rendering
// already falls back to that part's first starter asset/layout (see GoofyGuyAvatar.tsx)
// until real art lands at public/goofyguys/{shapes|limbs|eyes|hair|mouth}/{value}.png.
export const PREMIUM_AVATAR_ITEMS: PremiumAvatarItem[] = [
  // Keep the original ids stable for anyone who already bought the placeholder
  // items; the finished art now occupies those same stored avatar values.
  { id: "avatar_hair_neon", part: "hair", value: 6, name: "Top Hat", cost: 25 },
  { id: "avatar_hair_cat_ears", part: "hair", value: 7, name: "Cat Ears", cost: 25 },
  { id: "avatar_hair_party_hat", part: "hair", value: 8, name: "Party Hat", cost: 25 },
  { id: "avatar_mouth_grin", part: "mouth", value: 7, name: "Fancy Mustache", cost: 25 },
  // Was a free starter limbs value (3) until it got pulled into
  // PAYWALLED_STARTER_VALUES above — the art at limbs/3.png already exists,
  // so this is listed immediately instead of waiting on a placeholder.
  { id: "avatar_limbs_crossed", part: "limbs", value: 3, name: "Sophisticated Legs", cost: 50 },
];

export function maxAvatarValue(part: AvatarPartName): number {
  const premiumMax = PREMIUM_AVATAR_ITEMS.filter((item) => item.part === part).reduce(
    (max, item) => Math.max(max, item.value),
    0,
  );
  return Math.max(AVATAR_COUNTS[part], premiumMax);
}

export function isOwnedOrStarterValue(
  part: AvatarPartName,
  value: number,
  ownedItemIds: Set<string>,
): boolean {
  if (value <= AVATAR_COUNTS[part] && !isPaywalledStarterValue(part, value)) return true;
  const item = PREMIUM_AVATAR_ITEMS.find((entry) => entry.part === part && entry.value === value);
  return Boolean(item && ownedItemIds.has(item.id));
}

export type AvatarConfig = {
  shape?: number;
  limbs?: number;
  eye?: number;
  hair?: number;
  mouth?: number;
  // Legacy fields are kept readable so existing accounts upgrade seamlessly.
  color?: string;
  eyes?: number;
  mouths?: number;
  eyeStyle?: string;
  mouthStyle?: string;
};

export type ResolvedAvatarConfig = {
  shape: number;
  limbs: number;
  eye: number;
  hair: number;
  mouth: number;
};

export const DEFAULT_AVATAR: ResolvedAvatarConfig = {
  shape: 2,
  limbs: 2,
  eye: 1,
  hair: 1,
  mouth: 2,
};

// Used once, at account creation, so brand-new players don't all land on
// the exact same look — picks only from each part's free starter range
// (AVATAR_COUNTS), since a new account hasn't unlocked any premium items yet.
export function randomStarterAvatar(): ResolvedAvatarConfig {
  const pick = (part: AvatarPartName) => {
    let value: number;
    do {
      value = Math.floor(Math.random() * AVATAR_COUNTS[part]) + 1;
    } while (isPaywalledStarterValue(part, value));
    return value;
  };
  return {
    shape: pick("shape"),
    limbs: pick("limbs"),
    eye: pick("eye"),
    hair: pick("hair"),
    mouth: pick("mouth"),
  };
}

const LEGACY_COLORS = ["#D891D9", "#497CBF", "#CCD96C", "#D99F6C", "#BF5A5A"];
const SHAPE_ACCENTS = [
  "#BF5A5A",
  "#D99F6C",
  "#E9D780",
  "#765D7B",
  "#9EE1CE",
  "#497CBF",
  "#5C8581",
  "#D891D9",
];

function option(value: unknown, maximum: number, fallback: number) {
  const number = typeof value === "number" ? Math.floor(value) : Number(value);
  return Number.isFinite(number) && number >= 1 && number <= maximum
    ? number
    : fallback;
}

export function normalizeAvatar(value?: AvatarConfig | null): ResolvedAvatarConfig {
  const legacyShape = value?.color
    ? Math.max(1, LEGACY_COLORS.findIndex((color) => color.toLowerCase() === value.color?.toLowerCase()) + 1)
    : DEFAULT_AVATAR.shape;
  const shape = option(value?.shape, maxAvatarValue("shape"), legacyShape);
  return {
    shape,
    limbs: option(value?.limbs, maxAvatarValue("limbs"), shape),
    eye: option(value?.eye ?? value?.eyes, maxAvatarValue("eye"), DEFAULT_AVATAR.eye),
    hair: option(value?.hair, maxAvatarValue("hair"), DEFAULT_AVATAR.hair),
    mouth: option(value?.mouth ?? value?.mouths, maxAvatarValue("mouth"), DEFAULT_AVATAR.mouth),
  };
}

export function avatarAccent(value?: AvatarConfig | null) {
  const avatar = normalizeAvatar(value);
  return SHAPE_ACCENTS[avatar.shape - 1] ?? SHAPE_ACCENTS[0];
}

export type PhysicalShopItem = {
  id: string;
  kind: "physical";
  name: string;
  description: string;
  cost: number;
  iconName: string;
  color: string;
  // Real product photo, once one exists — the drawn icon (iconName) is the
  // fallback for items that don't have one yet.
  imageUrl: string | null;
  // Takes priority over imageUrl/iconName when set — a quick, zero-asset
  // stand-in for items that don't have (or don't need) real product art.
  emoji?: string | null;
};

export type AvatarShopItem = {
  id: string;
  kind: "avatar";
  name: string;
  description: string;
  cost: number;
  part: AvatarPartName;
  value: number;
  color: string;
};

export type BannerShopItem = {
  id: string;
  kind: "banner";
  name: string;
  description: string;
  cost: number;
  color: string;
};

export type ShopItem = PhysicalShopItem | AvatarShopItem | BannerShopItem;

const AVATAR_ITEM_COLORS = ["#D891D9", "#497CBF", "#CCD96C", "#D99F6C", "#BF5A5A"];

// Purely cosmetic and dirt cheap — tints the buyer's leaderboard row and
// profile hover card. Purple is deliberately left out: it's reserved for the
// galaxy rank tier (app/lib/rank.ts), not something anyone can just buy.
export const BANNER_ITEMS: BannerShopItem[] = [
  { id: "banner_pink", kind: "banner", name: "Pink Banner", description: "Tints your leaderboard row and profile card pink.", cost: 5, color: "var(--pink)" },
  { id: "banner_blue", kind: "banner", name: "Blue Banner", description: "Tints your leaderboard row and profile card blue.", cost: 5, color: "var(--blue)" },
  { id: "banner_green", kind: "banner", name: "Green Banner", description: "Tints your leaderboard row and profile card green.", cost: 5, color: "var(--green)" },
  { id: "banner_orange", kind: "banner", name: "Orange Banner", description: "Tints your leaderboard row and profile card orange.", cost: 5, color: "var(--orange)" },
  { id: "banner_red", kind: "banner", name: "Red Banner", description: "Tints your leaderboard row and profile card red.", cost: 5, color: "var(--red)" },
];

// Physical prizes live in data/shop-items.json (name, description, cost,
// icon fallback, and a real product photo once one exists) since they're
// plain catalog data — unlike avatar accessories below, which are rendered
// by compositing part+value onto a live avatar preview, not a flat image.
const PHYSICAL_SHOP_ITEMS: PhysicalShopItem[] = (
  physicalShopItemsData as Array<Omit<PhysicalShopItem, "kind">>
).map((item) => ({ ...item, kind: "physical" as const }));

// Single source of truth for the shop — the client (Shop/Wardrobe UI) and the
// server (app/api/shop/orders/route.ts) both import this instead of keeping
// hand-synced copies.
export const SHOP_CATALOG: ShopItem[] = [
  ...PHYSICAL_SHOP_ITEMS,
  ...PREMIUM_AVATAR_ITEMS.filter((item) => item.listed !== false).map((item, index) => ({
    id: item.id,
    kind: "avatar" as const,
    name: item.name,
    description: `Unlocks the "${item.name}" ${item.part} — equip it any time in the Wardrobe.`,
    cost: item.cost,
    part: item.part,
    value: item.value,
    color: AVATAR_ITEM_COLORS[index % AVATAR_ITEM_COLORS.length],
  })),
  ...BANNER_ITEMS,
];

export function shopItemById(id: string) {
  return SHOP_CATALOG.find((item) => item.id === id);
}

export function bannerItemByColor(color: string) {
  return BANNER_ITEMS.find((item) => item.color === color);
}
