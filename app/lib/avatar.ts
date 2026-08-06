export const AVATAR_COUNTS = {
  shape: 8,
  limbs: 8,
  eye: 7,
  hair: 5,
  mouth: 6,
} as const;

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
  const shape = option(value?.shape, AVATAR_COUNTS.shape, legacyShape);
  return {
    shape,
    limbs: option(value?.limbs, AVATAR_COUNTS.limbs, shape),
    eye: option(value?.eye ?? value?.eyes, AVATAR_COUNTS.eye, DEFAULT_AVATAR.eye),
    hair: option(value?.hair, AVATAR_COUNTS.hair, DEFAULT_AVATAR.hair),
    mouth: option(value?.mouth ?? value?.mouths, AVATAR_COUNTS.mouth, DEFAULT_AVATAR.mouth),
  };
}

export function avatarAccent(value?: AvatarConfig | null) {
  const avatar = normalizeAvatar(value);
  return SHAPE_ACCENTS[avatar.shape - 1] ?? SHAPE_ACCENTS[0];
}

