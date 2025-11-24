// app/api/line-webhook/route.ts
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";

// LINE 署名の検証
function verifyLineSignature(signature: string, body: string): boolean {
  const hmac = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hmac === signature;
}

export async function POST(req: NextRequest) {
  try {
    // ① 生のボディ文字列を取る（署名検証で使う）
    const bodyText = await req.text();
    const signature = req.headers.get("x-line-signature") ?? "";

    if (!verifyLineSignature(signature, bodyText)) {
      console.error("Invalid signature");
      // 401 を返すと LINE の検証でエラーになるので、
      // とりあえず 200 で返しつつログだけ出すでもOK
      return new NextResponse("invalid signature", { status: 401 });
    }

    // ② JSON にパース
    const body = JSON.parse(bodyText);
    const event = body.events?.[0];

    console.log("DEBUG event:", JSON.stringify(event, null, 2));

    // テキストメッセージ以外はスキップ
    if (!event || event.type !== "message" || event.message?.type !== "text") {
      return NextResponse.json({ ok: true });
    }

    const replyToken: string = event.replyToken;
    const userText: string = event.message.text;

    // ③ とりあえずエコーするだけ
    const replyText = `受け取りました：「${userText}」`;

    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: "text",
            text: replyText,
          },
        ],
      }),
    });

    const resText = await res.text();
    console.log("LINE reply status:", res.status, resText);

    // ④ ここは必ず 200 を返す
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("LINE webhook error:", err);
    // LINE 側から見ると 200 が返っていれば良いので、エラーでも 200 で返す
    return NextResponse.json({ ok: false });
  }
}