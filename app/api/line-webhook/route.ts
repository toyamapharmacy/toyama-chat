// app/api/line-webhook/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  console.log("LINE webhook hit (POST)");
  // ここでは、とりあえず何もせず 200 を返す
  return NextResponse.json({ ok: true });
}

// デバッグ用：ブラウザでアクセスして 200 を確認できるように GET も作る
export async function GET() {
  console.log("LINE webhook hit (GET)");
  return NextResponse.json({ ok: true, method: "GET" });
}