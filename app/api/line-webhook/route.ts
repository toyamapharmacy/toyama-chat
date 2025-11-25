// app/api/line-webhook/route.ts
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  parseCsv,
  searchPharmacies,
  formatPharmaciesForPrompt,
  SYSTEM_PROMPT,
} from "@/lib/pharmacy";
import { GoogleGenerativeAI } from "@google/generative-ai";

// 環境変数
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const SHEET_URL = process.env.SHEET_URL ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

/* ========== LINE 署名検証 ========== */
function validateSignature(bodyText: string, signature: string | null): boolean {
  if (!signature) return false;

  if (!LINE_CHANNEL_SECRET) {
    console.warn(
      "LINE_CHANNEL_SECRET が未設定のため署名チェックをスキップします。"
    );
    return true;
  }

  const hmac = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(bodyText)
    .digest("base64");

  return hmac === signature;
}

/* ========== LINE 返信ヘルパー ========== */
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

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature");

  // 署名チェック
  if (!validateSignature(bodyText, signature)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = JSON.parse(bodyText);
  const event = body.events?.[0];
  const userText: string = event?.message?.text ?? "";

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

    const csv = await fetch(SHEET_URL).then((r) => r.text());
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

    // 3) まずは「そのままリスト」を作る
    const listText = formatPharmaciesForPrompt(result);

    // ▼ ここではいったん Gemini を *必須にしない*
    if (!GEMINI_API_KEY) {
      // Gemini が使えない場合は、そのままリストを返す
      await replyText(event.replyToken, listText.slice(0, 4000));
      return NextResponse.json({ ok: true });
    }

    // ---------- ここから先を再度有効化すると Gemini 要約モード ----------
// 3) LLM（Gemini）で要約を作る
const listText = formatPharmaciesForPrompt(result);

// ★ ここで直接 SYSTEM_PROMPT を使う（systemPrompt という変数は使わない）
const msg = `
${SYSTEM_PROMPT}

▼ユーザーの質問
${userText}

▼候補薬局リスト
${listText}
`.trim();

const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

const geminiRes = await model.generateContent(msg);
const aiText = geminiRes.response.text().trim() || listText;

await replyText(event.replyToken, aiText.slice(0, 4000));
return NextResponse.json({ ok: true });
