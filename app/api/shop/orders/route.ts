import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

const catalog: Record<string, { name: string; cost: number }> = {
  stickers: { name: "Ranked sticker pack", cost: 100 },
  flipper: { name: "Flipper Zero", cost: 4500 },
  ipad: { name: "iPad", cost: 9000 },
  macbook: { name: "MacBook Air", cost: 18000 },
};

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const orders = await getSql()`SELECT id,item_id AS "itemId",item_name AS "itemName",cost,status,created_at AS "createdAt"
    FROM shop_orders WHERE user_id=${user.id} ORDER BY created_at DESC`;
  return NextResponse.json({ balance: user.hBucks, catalog, orders });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { itemId, shipping } = await request.json();
  const item = catalog[itemId];
  if (!item) return NextResponse.json({ error: "Unknown item" }, { status: 400 });
  if (!shipping?.name || !shipping?.address1 || !shipping?.city || !shipping?.postalCode || !shipping?.country) {
    return NextResponse.json({ error: "Complete the shipping address." }, { status: 400 });
  }
  const orderId = crypto.randomUUID();
  const result = await getSql()`WITH debit AS (
      UPDATE users SET h_bucks=h_bucks-${item.cost},updated_at=NOW() WHERE id=${user.id} AND h_bucks>=${item.cost} RETURNING h_bucks
    ), placed AS (
      INSERT INTO shop_orders (id,user_id,item_id,item_name,cost,shipping)
      SELECT ${orderId},${user.id},${itemId},${item.name},${item.cost},${JSON.stringify(shipping)}::jsonb FROM debit RETURNING id,status
    ) SELECT placed.id,placed.status,debit.h_bucks AS balance FROM placed CROSS JOIN debit`;
  if (!result.length) return NextResponse.json({ error: "Not enough H-Bucks." }, { status: 400 });
  return NextResponse.json({ order: result[0], balance: result[0].balance });
}
