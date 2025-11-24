// app/api/line-webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

import {
  SYSTEM_PROMPT,
  parseCsv,
  searchPharmacies,
  formatPharmaciesForPrompt,
  answerForSinglePharmacy,
} from "@/lib/pharmacy";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const SHEET_URL = process.env.SHEET_URL ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

// Gemini クライアント
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// --- LINE 署名検証 ---
function validateSignature(body: string, signature: string | null): boolean {
  if (!CHANNEL_SECRET || !signature) return false;

  const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
  const digest = hmac.update(body).digest("base64");
  return digest === signature;
}

// --- LINE 返信 ---
async function replyText(replyToken: string, text: string) {
  if (!ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
    return;
  }

  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    console.error("LINE reply error:", res.status, await res.text());
  }
}

// --- イベント単位の処理 ---
async function handleEvent(event: any) {
  // テキストメッセージ以外は無視
  if (event.type !== "message" || event.message.type !== "text") return;

  const userMessage: string = event.message.text;
  const replyToken: string = event.replyToken;

  if (!SHEET_URL) {
    await replyText(
      replyToken,
      "システム設定が未完了のため、薬局データを参照できません。管理者にご確認ください。"
    );
    return;
  }

  // CSV（Googleスプレッドシート）読み込み
  const resSheet = await fetch(SHEET_URL);
  if (!resSheet.ok) {
    await replyText(
      replyToken,
      "薬局データの取得に失敗しました。時間をおいて再度お試しください。"
    );
    return;
  }

  const csv = await resSheet.text();
  const records = parseCsv(csv);

  // Toyama Chat と同じ検索ロジック
  const { result, requestedTags, freeWords } = searchPharmacies(
    records,
    userMessage
  );

  // 0件・1件・複数件で分岐
  let reply: string;

  if (result.length === 0) {
    reply =
      "ご指定の条件に合致する薬局は見つかりませんでした。\n\n" +
      "・エリア名をもう少し広げてみる\n" +
      "・条件（在宅、休日、オンラインなど）を減らしてみる\n\n" +
      "などもお試しください。";
  } else if (result.length === 1) {
    // 1件だけなら、専用フォーマットでその薬局を詳しく案内
    const row = result[0];
    const title = (row["薬局名"] as string) ?? "該当の薬局";
    reply = answerForSinglePharmacy(row, title);
  } else {
    // 複数件ある場合は、Gemini に要約をお願いする
    const total = result.length;
    const listText = formatPharmaciesForPrompt(result);
    const areaWord = freeWords[0] ?? "";

    const intro =
      areaWord
        ? `${areaWord}エリアでご指定の条件に対応している薬局は全部で ${total} 件あります。そのうち代表的な 5 件をご案内します。`
        : `ご指定の条件に対応している薬局は全部で ${total} 件あります。そのうち代表的な 5 件をご案内します。`;

    let caution = "";
    if (requestedTags.includes("緊急避妊") && total === 0) {
      caution =
        "※現在のデータには、緊急避妊薬の取扱薬局の情報がありません。" +
        " お近くの医療機関や公的な相談窓口への相談をおすすめしてください。";
    }

    const geminiPrompt = [
      SYSTEM_PROMPT,
      "",
      `ユーザーからの質問：${userMessage}`,
      "",
      intro,
      "",
      "▼該当する薬局リスト",
      listText,
      "",
      caution,
      "",
      "上記の情報をもとに、LINEでそのまま送れる日本語の文章で、利用者にわかりやすく薬局を案内してください。",
      "・番号付きで薬局名を並べる",
      "・住所や営業時間のポイントを書く",
      "・必要であれば注意事項も簡潔に添える",
    ].join("\n");

    const resultGemini = await model.generateContent(geminiPrompt);
    const text = resultGemini.response.text();
    reply = text || `${intro}\n\n${listText}`;
  }

  await replyText(replyToken, reply);
}

// --- Webhook エンドポイント本体 ---
export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-line-signature");
  const bodyText = await req.text(); // 生のボディ（署名検証用）

  // 署名検証
  if (!validateSignature(bodyText, signature)) {
    console.error("Invalid signature");
    return new NextResponse("Invalid signature", { status: 400 });
  }

  // JSONとしてパース
  const body = JSON.parse(bodyText) as {
    events?: any[];
  };

  const events = body.events ?? [];

  // 全イベントを順に処理（エラーはログだけ吐いて 200 を返す）
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error("handleEvent error:", e);
    }
  }

  // LINE には必ず 200 を返す
  return NextResponse.json({ ok: true });
}

// 簡易確認用（ブラウザアクセスなど）
export async function GET() {
  return NextResponse.json({ ok: true, method: "GET" });
}
