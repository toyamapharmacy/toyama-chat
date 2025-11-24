// app/api/line-webhook/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

import {
  SYSTEM_PROMPT,
  parseCsv,
  normalizeForNameCompare,
  detectChainName,
  searchPharmacies,
  formatPharmaciesForPrompt,
  answerForSinglePharmacy,
} from "@/lib/pharmacy";

const SHEET_URL = process.env.SHEET_URL ?? "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

// Gemini 初期化
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

/* ========== LINE 署名検証 ========== */
function validateLineSignature(body: string, signature: string | null): boolean {
  if (!signature) return false;
  if (!LINE_CHANNEL_SECRET) return false;

  const hmac = crypto.createHmac("sha256", LINE_CHANNEL_SECRET);
  const digest = hmac.update(body).digest("base64");
  return digest === signature;
}

/* ========== LINE 返信ヘルパー ========== */
async function replyToLine(replyToken: string, text: string) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
    return;
  }

  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
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
    const body = await res.text().catch(() => "");
    console.error("LINE reply API error:", res.status, body);
  }
}

/* ========== Toyama Chat ロジックで回答生成 ========== */
async function generatePharmacyAnswer(userMessage: string): Promise<string> {
  if (!SHEET_URL) {
    throw new Error("SHEET_URL が設定されていません");
  }

  // シート取得
  const res = await fetch(SHEET_URL);
  if (!res.ok) {
    throw new Error(`シート取得に失敗しました: ${res.status}`);
  }
  const csv = await res.text();
  const records = parseCsv(csv);

  // ① 店名ダイレクトマッチ（「ウエルシア薬局富山水橋店」など）
  const normalizedUser = normalizeForNameCompare(userMessage);
  const directRow = records.find((row) => {
    const name = (row["薬局名"] ?? "") as string;
    if (!name) return false;
    const nName = normalizeForNameCompare(name);
    return nName.length > 0 && normalizedUser.includes(nName);
  });

  if (directRow) {
    const title = ((directRow["薬局名"] as string) ?? "該当の薬局").trim();
    return answerForSinglePharmacy(directRow, title);
  }

  // ② 「○○薬局△△店について」パターン（ゆるい検出）
  const chainName = detectChainName(userMessage);
  if (chainName) {
    const directMatches = records.filter((row) => {
      const name = (row["薬局名"] ?? "") as string;
      return name.includes(chainName);
    });

    if (directMatches.length === 1) {
      const row = directMatches[0];
      const title = ((row["薬局名"] as string) ?? chainName).trim();
      return answerForSinglePharmacy(row, title);
    }
  }

  // ③ 通常検索
  const { result, requestedTags, freeWords } = searchPharmacies(
    records,
    userMessage,
  );

  // 1 件だけならここでもサーバー側フォーマットを返す
  if (result.length === 1) {
    const row = result[0];
    const title = ((row["薬局名"] as string) ?? "該当の薬局").trim();
    return answerForSinglePharmacy(row, title);
  }

  const total = result.length;
  const listText = formatPharmaciesForPrompt(result);
  const areaWord = freeWords[0] ?? "";

  let caution = "";
  if (requestedTags.includes("緊急避妊") && result.length === 0) {
    caution =
      "※現在のデータには、緊急避妊薬の取扱薬局の情報がありません。" +
      " お近くの医療機関や公的な相談窓口への相談をおすすめしてください。";
  }

  const intro =
    total === 0
      ? "ご指定の条件に合致する薬局は見つかりませんでした。"
      : areaWord
      ? `${areaWord}エリアでご指定の条件に対応している薬局は全部で ${total} 件あります。そのうち代表的な 5 件をご案内します。`
      : `ご指定の条件に対応している薬局は全部で ${total} 件あります。そのうち代表的な 5 件をご案内します。`;

  // Gemini には 1 本のプロンプトとして投げる
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
  ].join("\n");

  const resultGemini = await model.generateContent(geminiPrompt);
  const text = resultGemini.response.text();

  return (
    text || "すみません、うまく回答を生成できませんでした。時間をおいてお試しください。"
  );
}

/* ========== Webhook エントリポイント ========== */
export async function POST(req: NextRequest) {
  try {
    const signature = req.headers.get("x-line-signature");
    const bodyText = await req.text();

    // 署名検証
    if (!validateLineSignature(bodyText, signature)) {
      console.error("LINE signature validation failed");
      return new NextResponse("Invalid signature", { status: 400 });
    }

    const body = JSON.parse(bodyText);

    if (!Array.isArray(body.events)) {
      return NextResponse.json({ status: "ok" });
    }

    // LINE は複数イベントをまとめて送ってくるのでループ
    for (const event of body.events) {
      if (
        event.type === "message" &&
        event.message &&
        event.message.type === "text"
      ) {
        const userText: string = event.message.text;
        const replyToken: string = event.replyToken;

        try {
          const answer = await generatePharmacyAnswer(userText);
          await replyToLine(replyToken, answer);
        } catch (err) {
          console.error("Error generating answer:", err);
          await replyToLine(
            replyToken,
            "サーバー側でエラーが発生しました。時間をおいて再度お試しください。",
          );
        }
      } else {
        // テキスト以外は一旦スルー（スタンプなど）
        if (event.replyToken) {
          await replyToLine(
            event.replyToken,
            "テキストメッセージでご質問ください。（例：堀川エリアで土曜日も開いている薬局）",
          );
        }
      }
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Webhook error:", err);
    return new NextResponse("Internal error", { status: 500 });
  }
}
