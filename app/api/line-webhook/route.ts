// app/api/line-webhook/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  // とりあえず OK を返すだけ（署名検証も何もしない）
  return NextResponse.json({ ok: true });
}