// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// ✅ ここを追加（パスは環境によって変更）
// ルートに tsconfig で `baseUrl: "."` & `paths` があれば "@/lib/pharmacy" で OK。
// もしなければ "../../../lib/pharmacy" など相対パスにしてください。
import {
  SYSTEM_PROMPT,
  parseCsv,
  normalizeForNameCompare,
  detectChainName,
  searchPharmacies,
  answerForSinglePharmacy,
  formatPharmaciesForPrompt,
} from "@/lib/pharmacy";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SHEET_URL = process.env.SHEET_URL ?? "";


/* ================= ルート本体 ================= */

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

    // ① 店名ダイレクトマッチ
    const normalizedUser = normalizeForNameCompare(userMessage);
    const directRow = records.find((row) => {
      const name = (row["薬局名"] ?? "") as string;
      if (!name) return false;
      const nName = normalizeForNameCompare(name);
      return nName.length > 0 && normalizedUser.includes(nName);
    });

    if (directRow) {
      const title =
        ((directRow["薬局名"] as string) ?? "該当の薬局").trim();
      const reply = answerForSinglePharmacy(directRow, title);
      return NextResponse.json({ reply });
    }

    // ② 「○○薬局△△店について」パターン
    const chainName = detectChainName(userMessage);
    if (chainName) {
      const directMatches = records.filter((row) => {
        const name = (row["薬局名"] ?? "") as string;
        return name.includes(chainName);
      });

      if (directMatches.length === 1) {
        const row = directMatches[0];
        const title =
          ((row["薬局名"] as string) ?? chainName).trim();
        const reply = answerForSinglePharmacy(row, title);
        return NextResponse.json({ reply });
      }
    }

    // ③ 通常検索
    const { result, requestedTags, freeWords } = searchPharmacies(
      records,
      userMessage,
    );

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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `ユーザーからの質問：\n${userMessage}\n\n` +
            `${intro}\n\n` +
            `▼該当する薬局リスト\n${listText}\n\n${caution}`,
        },
      ],
    });

    const reply =
      completion.choices[0]?.message?.content ??
      "すみません、うまく回答を生成できませんでした。";

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