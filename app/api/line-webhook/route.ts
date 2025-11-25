// app/api/line-webhook/route.ts
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs"; // crypto を使うので node 実行環境を指定

// --- 環境変数 -------------------------------------------------

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";

/**
 * /api/chat を叩くときのベース URL
 * - NEXT_PUBLIC_BASE_URL があればそれを優先
 * - なければ VERCEL_URL（自動で入る）を利用
 * - どちらも無ければ最後のハードコードを使う
 */
const CHAT_API_ORIGIN =
  process.env.NEXT_PUBLIC_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://toyama-chat-navi.vercel.app");

// --- LINE 返信ヘルパー ---------------------------------------

async function replyText(replyToken: string, text: string) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
    throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
  }

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
    console.error("LINE reply API error", res.status, await res.text());
    throw new Error("Failed to reply message to LINE");
  }
}

// --- 署名検証 -------------------------------------------------

function validateSignature(bodyText: string, signature: string | null): boolean {
  if (!signature) return false;
  if (!CHANNEL_SECRET) {
    // 開発中に署名を無視したい場合はここで true を返す
    console.warn("CHANNEL_SECRET が設定されていないため署名検証をスキップしました");
    return true;
  }

  const hmac = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(bodyText)
    .digest("base64");

  return hmac === signature;
}

// --- メイン処理 ----------------------------------------------

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature");

  // 署名 NG のときは 401
  if (!validateSignature(bodyText, signature)) {
    console.warn("Invalid LINE signature");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    console.error("Failed to parse LINE body as JSON", e);
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const event = body.events?.[0];
  const replyToken: string | undefined = event?.replyToken;

  // 想定外のイベントの場合は何もしないで 200
  if (!event || !replyToken) {
    return NextResponse.json({ ok: true });
  }

  // メッセージ以外（フォローイベント等）はスルー
  if (event.type !== "message") {
    return NextResponse.json({ ok: true });
  }

  // テキスト以外（スタンプ・画像など）はスルー
  if (event.message?.type !== "text") {
    await replyText(replyToken, "テキストメッセージで質問してくださいね。");
    return NextResponse.json({ ok: true });
  }

  const userText: string = event.message.text ?? "";

  // デバッグ用ルート
  if (userText === "テスト") {
    await replyText(replyToken, `受け取りました：「${userText}」`);
    return NextResponse.json({ ok: true });
  }

  try {
    // --------------------------
    // ここで自分の /api/chat を呼ぶ
    // --------------------------
    const chatRes = await fetch(`${CHAT_API_ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // /api/chat 側は { messages: [{ role, content }] } 形式を想定
      body: JSON.stringify({
        messages: [{ role: "user", content: userText }],
      }),
    });

    if (!chatRes.ok) {
      console.error("chat API error", chatRes.status, await chatRes.text());
      await replyText(
        replyToken,
        "システム側でエラーが発生しました。時間をおいてもう一度お試しください。",
      );
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    const data = await chatRes.json();
    const aiReply: string =
      (data.reply as string) ?? (data.message as string) ?? "";

    await replyText(
      replyToken,
      aiReply || "すみません、うまく回答を生成できませんでした。",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("LINE webhook error", err);
    try {
      await replyText(
        replyToken,
        "システム側でエラーが発生しました。時間をおいてもう一度お試しください。",
      );
    } catch (e) {
      // 返信自体に失敗した場合もログだけ残しておく
      console.error("Failed to send error reply to LINE", e);
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}