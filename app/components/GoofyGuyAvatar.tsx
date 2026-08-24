"use client";

/* The avatar is a stack of tiny transparent PNG layers; native images preserve their exact alpha bounds. */
/* eslint-disable @next/next/no-img-element */
import {
  AVATAR_COUNTS,
  PREMIUM_AVATAR_ITEMS,
  normalizeAvatar,
  type AvatarConfig,
  type PremiumAvatarItem,
  type ResolvedAvatarConfig,
} from "@/app/lib/avatar";

const LABELS = {
  shape: "shape",
  limbs: "limbs",
  eye: "eyes",
  hair: "hair",
  mouth: "mouth",
} as const;

type AvatarPart = keyof typeof LABELS;

const AVATAR_REFERENCE = { width: 510, height: 530, bodyCenterY: 43 };

const SHAPE_DIMENSIONS = [
  { width: 216, height: 228 },
  { width: 264, height: 223 },
  { width: 331, height: 251 },
  { width: 293, height: 216 },
  { width: 293, height: 258 },
  { width: 279, height: 282 },
  { width: 344, height: 302 },
  { width: 252, height: 216 },
] as const;

// Measurements recovered from the artist's original sheets. Offsets are from
// each limb set's original shape center, so arbitrary combinations can be
// resized to the selected shape without losing their attachment points.
const LIMB_LAYOUTS = [
  { width: 310, height: 177, offsetX: 33, offsetY: 117.5, shapeWidth: 216, shapeHeight: 228 },
  { width: 293, height: 240, offsetX: -11.5, offsetY: 85.5, shapeWidth: 264, shapeHeight: 223 },
  { width: 283, height: 250, offsetX: -20, offsetY: 161.5, shapeWidth: 331, shapeHeight: 251 },
  { width: 345, height: 289, offsetX: 3, offsetY: 153.5, shapeWidth: 293, shapeHeight: 216 },
  { width: 428, height: 309, offsetX: -2.5, offsetY: 78.5, shapeWidth: 293, shapeHeight: 258 },
  { width: 277, height: 509, offsetX: 2, offsetY: 26.5, shapeWidth: 279, shapeHeight: 282 },
  { width: 257, height: 333, offsetX: -7.5, offsetY: 134.5, shapeWidth: 344, shapeHeight: 302 },
  { width: 365, height: 370, offsetX: -11.5, offsetY: 85, shapeWidth: 252, shapeHeight: 216 },
] as const;

type FeaturePart = "eye" | "hair" | "mouth";

// Each feature keeps the size and face anchor it had in sample-ref.png. The
// reference shape lets us carry that same proportion onto any selected body
// without squeezing wide, tall, or narrow drawings into a generic box.
const FEATURE_LAYOUTS = {
  eye: [
    { width: 133, height: 55, offsetX: -5.5, offsetY: -20.5, shape: 1 },
    { width: 78, height: 55, offsetX: 1, offsetY: -26, shape: 2 },
    { width: 196, height: 48, offsetX: 4.5, offsetY: -27.5, shape: 3 },
    { width: 217, height: 61, offsetX: 1, offsetY: -55.5, shape: 4 },
    { width: 167, height: 76, offsetX: 12, offsetY: -57, shape: 5 },
    { width: 137, height: 132, offsetX: -4.5, offsetY: -4, shape: 7 },
    { width: 131, height: 65, offsetX: 7.5, offsetY: -22.5, shape: 8 },
  ],
  hair: [
    { width: 134, height: 73, offsetX: 2, offsetY: -102, shape: 2 },
    { width: 180, height: 97, offsetX: -22.5, offsetY: -110, shape: 3 },
    { width: 192, height: 80, offsetX: -15.5, offsetY: -144, shape: 5 },
    { width: 158, height: 47, offsetX: 18, offsetY: -100.5, shape: 7 },
    { width: 174, height: 46, offsetX: 1, offsetY: -110, shape: 8 },
  ],
  mouth: [
    { width: 29, height: 52, offsetX: 5.5, offsetY: 51, shape: 1 },
    { width: 143, height: 78, offsetX: -0.5, offsetY: 48.5, shape: 2 },
    { width: 129, height: 55, offsetX: 3, offsetY: 46, shape: 3 },
    { width: 89, height: 46, offsetX: 3, offsetY: 46, shape: 5 },
    { width: 93, height: 58, offsetX: -13.5, offsetY: 54, shape: 8 },
    { width: 144, height: 60, offsetX: 11.5, offsetY: 14, shape: 4 },
  ],
} as const;

function featureLayout(
  part: FeaturePart,
  value: number,
  targetShape: (typeof SHAPE_DIMENSIONS)[number],
) {
  const measurement =
    FEATURE_LAYOUTS[part][value - 1] ?? FEATURE_LAYOUTS[part][0];
  const referenceShape = SHAPE_DIMENSIONS[measurement.shape - 1];
  const horizontalScale = targetShape.width / referenceShape.width;
  const verticalScale = targetShape.height / referenceShape.height;
  const percentX = (pixels: number) =>
    (pixels / AVATAR_REFERENCE.width) * 100;
  const percentY = (pixels: number) =>
    (pixels / AVATAR_REFERENCE.height) * 100;

  return {
    width: `${percentX(measurement.width * horizontalScale)}%`,
    height: `${percentY(measurement.height * horizontalScale)}%`,
    left: `${50 + percentX(measurement.offsetX * horizontalScale)}%`,
    top: `${
      AVATAR_REFERENCE.bodyCenterY +
      percentY(measurement.offsetY * verticalScale)
    }%`,
  };
}

function avatarLayout(avatar: ResolvedAvatarConfig) {
  const shape = SHAPE_DIMENSIONS[avatar.shape - 1] ?? SHAPE_DIMENSIONS[0];
  const limbs = LIMB_LAYOUTS[avatar.limbs - 1] ?? LIMB_LAYOUTS[0];
  const horizontalScale = shape.width / limbs.shapeWidth;
  const verticalScale = shape.height / limbs.shapeHeight;
  const percentX = (pixels: number) => (pixels / AVATAR_REFERENCE.width) * 100;
  const percentY = (pixels: number) => (pixels / AVATAR_REFERENCE.height) * 100;

  return {
    shape: {
      width: `${percentX(shape.width)}%`,
      height: `${percentY(shape.height)}%`,
      left: "50%",
      top: `${AVATAR_REFERENCE.bodyCenterY}%`,
    },
    limbs: {
      width: `${percentX(limbs.width * horizontalScale)}%`,
      height: `${percentY(limbs.height * verticalScale)}%`,
      left: `${50 + percentX(limbs.offsetX * horizontalScale)}%`,
      top: `${AVATAR_REFERENCE.bodyCenterY + percentY(limbs.offsetY * verticalScale)}%`,
    },
    features: { width: "100%", height: "100%", left: "0", top: "0" },
    eye: featureLayout("eye", avatar.eye, shape),
    hair: featureLayout("hair", avatar.hair, shape),
    mouth: featureLayout("mouth", avatar.mouth, shape),
  };
}

function assetPath(part: AvatarPart, value: number) {
  const folder = part === "shape" ? "shapes" : part === "eye" ? "eyes" : part;
  return `/goofyguys/${folder}/${value}.png`;
}

export function ScribbleAvatar({
  avatar,
  size = "lg",
  label = "Player avatar",
}: {
  avatar?: AvatarConfig | null;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const selected = normalizeAvatar(avatar);
  const inverted = selected.limbs === 6;
  const layout = avatarLayout(selected);

  return (
    <div
      className={`scribble-avatar goofy-guy-avatar avatar-${size}`}
      role="img"
      aria-label={label}
      data-shape={selected.shape}
      data-limbs={selected.limbs}
    >
      <img
        className="goofy-guy-layer goofy-guy-limbs"
        src={assetPath("limbs", selected.limbs)}
        style={layout.limbs}
        alt=""
        draggable={false}
      />
      <img
        className="goofy-guy-layer goofy-guy-shape"
        src={assetPath("shape", selected.shape)}
        style={layout.shape}
        alt=""
        draggable={false}
      />
      <span
        className={`goofy-guy-features${inverted ? " inverted" : ""}`}
        style={layout.features}
      >
        <img
          className="goofy-guy-layer goofy-guy-hair"
          src={assetPath("hair", selected.hair)}
          style={layout.hair}
          alt=""
          draggable={false}
        />
        <img
          className="goofy-guy-layer goofy-guy-eyes"
          src={assetPath("eye", selected.eye)}
          style={layout.eye}
          alt=""
          draggable={false}
        />
        <img
          className="goofy-guy-layer goofy-guy-mouth"
          src={assetPath("mouth", selected.mouth)}
          style={layout.mouth}
          alt=""
          draggable={false}
        />
      </span>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="avatar-lock-glyph"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function PartPicker({
  part,
  value,
  allowedValues,
  onChange,
  lockedItems = [],
}: {
  part: AvatarPart;
  value: number;
  allowedValues: number[];
  onChange: (value: number) => void;
  lockedItems?: PremiumAvatarItem[];
}) {
  const currentIndex = Math.max(0, allowedValues.indexOf(value));
  const changeBy = (direction: -1 | 1) => {
    const nextIndex =
      (currentIndex + direction + allowedValues.length) % allowedValues.length;
    onChange(allowedValues[nextIndex]);
  };

  return (
    <fieldset
      className="avatar-part-picker"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        changeBy(event.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      <legend>{LABELS[part]}</legend>
      <div className="avatar-part-controls">
        <button
          type="button"
          onClick={() => changeBy(-1)}
          aria-label={`Previous ${LABELS[part]}`}
        >
          <span aria-hidden="true">←</span>
        </button>
        <div className="avatar-current-part" aria-live="polite">
          <img src={assetPath(part, value)} alt="" draggable={false} />
          <span>
            {currentIndex + 1} / {allowedValues.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => changeBy(1)}
          aria-label={`Next ${LABELS[part]}`}
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
      {lockedItems.length > 0 && (
        <div className="avatar-part-locked">
          {lockedItems.map((item) => (
            <span
              key={item.id}
              className="avatar-locked-chip"
              title={`${item.name} — unlock in the Shop for ${item.cost} Ħ`}
            >
              <img
                src={assetPath(part, item.value)}
                alt=""
                draggable={false}
                onError={(event) => {
                  event.currentTarget.style.visibility = "hidden";
                }}
              />
              <LockGlyph />
            </span>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function AvatarCustomizer({
  value,
  onChange,
  ownedPremiumIds,
}: {
  value: AvatarConfig;
  onChange: (next: ResolvedAvatarConfig) => void;
  // Omit entirely for the free onboarding pool (today's behavior, unchanged).
  // Pass the user's owned item ids to additionally allow/show their purchased
  // Wardrobe looks.
  ownedPremiumIds?: Set<string>;
}) {
  const avatar = normalizeAvatar(value);
  const setPart = (part: AvatarPart, next: number) =>
    onChange({ ...avatar, [part]: next });

  const allowedValuesByPart = (Object.keys(LABELS) as AvatarPart[]).reduce(
    (map, part) => {
      const starterValues = Array.from(
        { length: AVATAR_COUNTS[part] },
        (_, index) => index + 1,
      );
      const ownedPremiumValues = ownedPremiumIds
        ? PREMIUM_AVATAR_ITEMS.filter(
            (item) => item.part === part && ownedPremiumIds.has(item.id),
          ).map((item) => item.value)
        : [];
      map[part] = [...starterValues, ...ownedPremiumValues];
      return map;
    },
    {} as Record<AvatarPart, number[]>,
  );

  const randomPick = (part: AvatarPart) => {
    const options = allowedValuesByPart[part];
    return options[Math.floor(Math.random() * options.length)];
  };

  return (
    <div className="avatar-customizer">
      <div className="avatar-stage">
        <ScribbleAvatar avatar={avatar} label="Your customized Scrib" />
      </div>
      <div className="avatar-pickers">
        {(Object.keys(LABELS) as AvatarPart[]).map((part) => (
          <PartPicker
            key={part}
            part={part}
            value={avatar[part]}
            allowedValues={allowedValuesByPart[part]}
            onChange={(next) => setPart(part, next)}
            lockedItems={PREMIUM_AVATAR_ITEMS.filter(
              (item) => item.part === part && !ownedPremiumIds?.has(item.id),
            )}
          />
        ))}
      </div>
      <button
        type="button"
        className="shuffle-button"
        onClick={() =>
          onChange({
            shape: randomPick("shape"),
            limbs: randomPick("limbs"),
            eye: randomPick("eye"),
            hair: randomPick("hair"),
            mouth: randomPick("mouth"),
          })
        }
      >
        ↝ shuffle me
      </button>
    </div>
  );
}
