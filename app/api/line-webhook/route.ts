// app/api/line-webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

import {
  SYSTEM_PROMPT,
  parseCsv,
  searchPharmacies,
  formatPharmaciesForPrompt,
  answerForSinglePharmacy,
} from "@/lib/pharmacy";

// --- 環境変数 -------------------------------------------------
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const SHEET_URL = process.env.SHEET_URL ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

// Gemini クライアント
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// --- LINE 署名検証 ---------------------------------------------
function verifyLineSignature(rawBody: string, signature: string | null) {
  if (!CHANNEL_SECRET || !signature) return false;

  const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
  hmac.update(rawBody);
  const expected = hmac.digest("base64");
  return expected === signature;
}

// --- Toyama Chat と同じ「薬局検索＋Gemini」ロジック -------------
async function buildAnswerFromPharmacySheet(userText: string): Promise<string> {
  if (!SHEET_URL) {
    return "サーバー側の設定に不備があり、薬局データにアクセスできません。管理者へご確認ください。";
  }

  // Google スプレッドシート（CSV公開済み）を取得
  const res = await fetch(SHEET_URL);
  if (!res.ok) {
    return `薬局データの取得に失敗しました（${res.status}）。時間をおいてお試しください。`;
  }
  const csv = await res.text();
  const records = parseCsv(csv);

  // Toyama Chat と同じ検索
  const { result, requestedTags, freeWords } = searchPharmacies(
    records,
    userText,
  );

  if (result.length === 0) {
    if (requestedTags.includes("緊急避妊")) {
      return [
        "ご指定の条件に合致する薬局は見つかりませんでした。",
        "",
        "※現在のデータには、緊急避妊薬の取扱薬局の情報がありません。",
        "  お近くの医療機関や公的な相談窓口への相談をおすすめしてください。",
      ].join("\n");
    }
    return "ご指定の条件に合致する薬局は見つかりませんでした。エリア名や条件の言い方を少し変えてお試しください。";
  }

  // 1件だけのときは、Toyama Chat と同じフォーマットで固定テキスト返信
  if (result.length === 1) {
    const row = result[0];
    const title = (row["薬局名"] as string) ?? "該当の薬局";
    return answerForSinglePharmacy(row, title);
  }

  // 2件以上あるときは Gemini に「代表 5件の説明」をお願いする
  const total = result.length;
  const listText = formatPharmaciesForPrompt(result);
  const areaWord = freeWords[0] ?? "";

  const intro =
    areaWord
      ? `${areaWord}エリアでご指定の条件に対応している薬局は全部で ${total} 件あります。そのうち代表的な 5 件を、患者さん目線でわかりやすく案内してください。`
      : `ご指定の条件に対応している薬局は全部で ${total} 件あります。そのうち代表的な 5 件を、患者さん目線でわかりやすく案内してください。`;

  const prompt = [
    SYSTEM_PROMPT,
    "",
    `ユーザーからの質問：${userText}`,
    "",
    intro,
    "",
    "▼該当する薬局リスト",
    listText,
  ].join("\n");

  const geminiResult = await model.generateContent(prompt);
  const text = geminiResult.response.text();
  return (
    text ||
    "該当する薬局は見つかりましたが、説明文の生成に失敗しました。時間をおいて再度お試しください。"
  );
}

// --- LINE へ返信 ----------------------------------------------
async function replyToLine(replyToken: string, text: string) {
  if (!CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
    return;
  }

  const trimmed = text.slice(0, 4900); // LINE の上限対策で一応短く

  await fetch("https://api.line.me/v2/bot/message/reply", {
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
          text: trimmed,
        },
      ],
    }),
  });
}

// --- POST: LINE Webhook 本体 ----------------------------------
export async function POST(req: NextRequest) {
  try {
    const signature = req.headers.get("x-line-signature");
    const bodyText = await req.text(); // 署名検証のため raw で取得

    if (!verifyLineSignature(bodyText, signature)) {
      console.warn("LINE signature validation failed");
      return new NextResponse("signature validation failed", { status: 401 });
    }

    const body = JSON.parse(bodyText);

    const events = body.events ?? [];
    // まとめて処理（複数イベントが来ることもある）
    await Promise.all(
      events.map(async (event: any) => {
        if (event.type !== "message") return;
        if (!event.message || event.message.type !== "text") return;

        const userText: string = event.message.text ?? "";
        const answer = await buildAnswerFromPharmacySheet(userText);
        await replyToLine(event.replyToken, answer);
      }),
    );

    // LINE には 200 を返せば OK
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("LINE webhook error", err);
    // ここでも 200 を返しておくと LINE 側のリトライが暴走しにくい
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}

// --- GET: ブラウザからの動作確認用（任意） ---------------------
export async function GET() {
  return NextResponse.json({ ok: true, method: "GET" });
}
