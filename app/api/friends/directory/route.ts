import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const members = await getSql()`SELECT id, name, email FROM users WHERE id<>${user.id} ORDER BY name`;
  return NextResponse.json({ members });
}
