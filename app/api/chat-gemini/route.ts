// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

import {
  SYSTEM_PROMPT,
  parseCsv,
  searchPharmacies,
  formatPharmaciesForPrompt,
  answerForSinglePharmacy,
} from "@/lib/pharmacy";

const SHEET_URL = process.env.SHEET_URL ?? "";

// OpenAI クライアント
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Gemini クライアント
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// --------------------------------------------------
// 共通で使う LLM 呼び出しヘルパー
// --------------------------------------------------
type LlmParams = {
  systemPrompt: string;
  userMessage: string;
  intro: string;
  listText: string;
  caution: string;
};

async function generateReplyWithLLM(params: LlmParams): Promise<string> {
  const { systemPrompt, userMessage, intro, listText, caution } = params;

  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();

  // ===== Gemini =====
  if (provider === "gemini") {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const geminiPrompt = [
      systemPrompt,
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

    const result = await model.generateContent(geminiPrompt);
    return result.response.text() ?? "";
  }

  // ===== OpenAI（デフォルト） =====
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `ユーザーからの質問：\n${userMessage}\n\n` +
          `${intro}\n\n` +
          `▼該当する薬局リスト\n${listText}\n\n${caution}`,
      },
    ],
  });

  return completion.choices[0]?.message?.content ?? "";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = body.messages ?? [];
    const userMessage: string =
      messages[messages.length - 1]?.content ?? "";

    if (!SHEET_URL) {
      throw new Error("SHEET_URL が設定されていません");
    }

    const res = await fetch(SHEET_URL);
    if (!res.ok) {
      throw new Error(`シート取得に失敗しました: ${res.status}`);
    }
    const csv = await res.text();
    const records = parseCsv(csv);

    // ……（ここまでの 店名ダイレクト検索 / searchPharmacies は今まで通り）

    const { result, requestedTags, freeWords } = searchPharmacies(
      records,
      userMessage,
    );

    // 1件だけならサーバー側で確定表示
    if (result.length === 1) {
      const row = result[0];
      const title =
        ((row["薬局名"] as string) ?? "該当の薬局").trim();
      const reply = answerForSinglePharmacy(row, title);
      return NextResponse.json({ reply });
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

    // ★ ここだけ共通ヘルパーに置き換え
    const replyRaw = await generateReplyWithLLM({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      intro,
      listText,
      caution,
    });

    const reply =
      replyRaw || "すみません、うまく回答を生成できませんでした。";

    return NextResponse.json({ reply });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      {
        reply:
          "サーバー側でエラーが発生しました。時間をおいて再度お試しください。",
      },
      { status: 500 },
    );
  }
}