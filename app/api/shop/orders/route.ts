import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { logAudit } from "@/app/lib/audit";
import { SHOP_CATALOG, shopItemById } from "@/app/lib/avatar";
import { addChallengeProgress } from "@/app/lib/progression";
import {
  completeSubmissionAddresses,
  getHackClubProfile,
} from "@/app/lib/hack-club-profile";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const orders = await getSql()`SELECT id,item_id AS "itemId",item_name AS "itemName",cost,status,created_at AS "createdAt"
    FROM shop_orders WHERE user_id=${user.id} ORDER BY created_at DESC`;
  return NextResponse.json({ balance: user.hBucks, catalog: SHOP_CATALOG, orders });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { itemId, addressId } = await request.json();
  const item = shopItemById(itemId);
  if (!item) return NextResponse.json({ error: "Unknown item" }, { status: 400 });

  // Shipping now always resolves from the player's own Hack Club Auth
  // addresses, keyed by the id they picked in the dropdown, rather than
  // trusting whatever free-text a form submitted — same reasoning as the
  // match-publish flow's move to a server-resolved HCA address.
  let shipping: Record<string, string | null> | null = null;
  if (item.kind === "avatar") {
    const owned = await getSql()`SELECT 1 FROM shop_orders WHERE user_id=${user.id} AND item_id=${itemId} LIMIT 1`;
    if (owned.length) return NextResponse.json({ error: "You already own this." }, { status: 400 });
  } else {
    const profile = await getHackClubProfile(user.id);
    const selected = completeSubmissionAddresses(profile).find(
      (address) => address.id === addressId,
    );
    if (!profile || !selected) {
      return NextResponse.json(
        { error: "Choose a shipping address from your Hack Club Auth account.", code: "hca_address_required" },
        { status: 400 },
      );
    }
    shipping = {
      name: [selected.first_name || profile.firstName, selected.last_name || profile.lastName]
        .filter(Boolean)
        .join(" "),
      address1: selected.line_1 ?? null,
      address2: selected.line_2 ?? null,
      city: selected.city ?? null,
      region: selected.state ?? null,
      postalCode: selected.postal_code ?? null,
      country: selected.country ?? null,
      hcaAddressId: selected.id,
    };
  }

  const orderId = crypto.randomUUID();
  // Digital avatar unlocks have nothing to ship, so they auto-approve instead of
  // sitting in the manual shipping-approval queue physical prizes go through.
  const status = item.kind === "avatar" ? "approved" : "pending";
  const shippingJson = shipping ? JSON.stringify(shipping) : null;
  const result = await getSql()`WITH debit AS (
      UPDATE users SET h_bucks=h_bucks-${item.cost},updated_at=NOW() WHERE id=${user.id} AND h_bucks>=${item.cost} RETURNING h_bucks
    ), placed AS (
      INSERT INTO shop_orders (id,user_id,item_id,item_name,cost,status,shipping)
      SELECT ${orderId},${user.id},${itemId},${item.name},${item.cost},${status}::order_status,${shippingJson}::jsonb FROM debit RETURNING id,status
    ) SELECT placed.id,placed.status,debit.h_bucks AS balance FROM placed CROSS JOIN debit`;
  if (!result.length) return NextResponse.json({ error: "Not enough H-Bucks." }, { status: 400 });
  await addChallengeProgress(user.id, "shop_purchase", 1);
  await logAudit({
    actor: { id: user.id, name: user.name, email: user.email },
    action: item.kind === "avatar" ? "shop.avatar_item.unlocked" : "shop.order.created",
    summary: item.kind === "avatar"
      ? `${user.name} bought "${item.name}" for ${item.cost} Ħ`
      : `${user.name} redeemed ${item.name} for ${item.cost} Ħ — pending shipping approval`,
    targetType: "shop_order",
    targetId: orderId,
    metadata: { itemId, cost: item.cost },
  });
  return NextResponse.json({ order: result[0], balance: result[0].balance });
}
