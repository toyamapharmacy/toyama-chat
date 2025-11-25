// app/api/line-webhook/route.ts
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

// /api/chat の POST ハンドラを直接呼び出すために import
import { POST as chatPost } from "../chat/route";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";

// ------------------------------------
// LINE への返信ヘルパー
// ------------------------------------
async function replyText(replyToken: string, text: string) {
  const url = "https://api.line.me/v2/bot/message/reply";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error("LINE reply API error", await res.text());
    throw new Error("Failed to reply message to LINE");
  }
}

// ------------------------------------
// 署名検証
// ------------------------------------
function validateSignature(bodyText: string, signature: string | null): boolean {
  if (!signature) return false;
  if (!CHANNEL_SECRET) return true; // 開発中だけスキップしたい場合

  const hmac = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(bodyText)
    .digest("base64");

  return hmac === signature;
}

// ------------------------------------
// Webhook 本体
// ------------------------------------
export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature");

  // 署名 NG のときは 401
  if (!validateSignature(bodyText, signature)) {
    console.error("LINE signature validation failed");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = JSON.parse(bodyText);
  const event = body.events?.[0];

  if (!event) {
    return NextResponse.json({ ok: true }); // 念のため
  }

  const userText: string = event?.message?.text ?? "";

  // デバッグ用ルート（動作確認）
  if (userText === "テスト") {
    await replyText(event.replyToken, `受け取りました：「${userText}」`);
    return NextResponse.json({ ok: true });
  }

  try {
    // ------------------------------------
    // /api/chat のロジックを「直接」呼び出す
    // ------------------------------------
    const chatReqBody = {
      messages: [{ role: "user", content: userText }],
    };

    // chatPost は Next.js の route handler (POST) なので
    // ダミーの URL で NextRequest を作って渡す
    const internalReq = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatReqBody),
    });

    const chatRes = await chatPost(internalReq);

    if (!chatRes.ok) {
      console.error("internal chat API error", chatRes.status, await chatRes.text());
      await replyText(
        event.replyToken,
        "システム側でエラーが発生しました。時間をおいてもう一度お試しください。",
      );
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    const data = await chatRes.json();
    const aiReply: string = data.reply ?? data.message ?? "";

    await replyText(
      event.replyToken,
      aiReply || "すみません、うまく回答を生成できませんでした。",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("LINE webhook error", err);
    try {
      await replyText(
        event.replyToken,
        "システム側でエラーが発生しました。時間をおいてもう一度お試しください。",
      );
    } catch (e) {
      console.error("failed to send error message to LINE", e);
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}