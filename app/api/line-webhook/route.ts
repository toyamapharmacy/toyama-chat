// app/api/line-webhook/route.ts
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

import {
  parseCsv,
  searchPharmacies,
  formatPharmaciesForPrompt,
  SYSTEM_PROMPT,
} from "@/lib/pharmacy";

const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const SHEET_URL = process.env.SHEET_URL ?? "";

// 署名検証
function validateSignature(bodyText: string, signature: string | null): boolean {
  if (!signature) return false;

  if (!LINE_CHANNEL_SECRET) {
    console.warn(
      "LINE_CHANNEL_SECRET が設定されていません。署名チェックをスキップします。"
    );
    return true;
  }

  const hmac = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(bodyText)
    .digest("base64");

  return hmac === signature;
}

// テキスト返信
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
      messages: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    console.error("LINE reply API error", await res.text());
    throw new Error("Failed to reply message to LINE");
  }
}

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!validateSignature(bodyText, signature)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = JSON.parse(bodyText);
  const event = body.events?.[0];
  const userText: string = event?.message?.text ?? "";

  if (!event || !userText) {
    return NextResponse.json({ ok: true });
  }

  // デバッグ用ルート
  if (userText === "テスト") {
    await replyText(event.replyToken, `受け取りました：「${userText}」`);
    return NextResponse.json({ ok: true });
  }

  try {
    // 1) CSV 読み込み
    if (!SHEET_URL) {
      throw new Error("SHEET_URL が設定されていません");
    }

    const csvRes = await fetch(SHEET_URL);
    const csv = await csvRes.text();
    const records = parseCsv(csv);

    // 2) 検索
    const { result } = searchPharmacies(records, userText);

    if (result.length === 0) {
      await replyText(
        event.replyToken,
        "ご指定の条件に合致する薬局は見つかりませんでした。エリア名や条件の言い方を少し変えてお試しください。"
      );
      return NextResponse.json({ ok: true });
    }

    // 3) Gemini で要約
    const listText = formatPharmaciesForPrompt(result);
    const systemPrompt = SYSTEM_PROMPT;

    const msg = `
${systemPrompt}

▼ユーザーの質問
${userText}

▼候補薬局リスト
${listText}
`.trim();

    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
    const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

    const res = await model.generateContent(msg);
    const aiText = res.response.text().trim() || listText;

    await replyText(event.replyToken, aiText.slice(0, 4000));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("LINE webhook error", err);
    await replyText(
      event.replyToken,
      "システム側でエラーが発生しました。時間をおいてもう一度お試しください。"
    );
    return NextResponse.json({ ok: false });
  }
}