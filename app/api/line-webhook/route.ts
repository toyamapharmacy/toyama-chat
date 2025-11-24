// 省略: import と LINE 署名検証 etc...

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!validateSignature(bodyText, signature)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = JSON.parse(bodyText);
  const event = body.events?.[0];
  const userText = event?.message?.text ?? "";

  // デバッグ用の特別ルート
  if (userText === "テスト") {
    await replyText(event.replyToken, `受け取りました：「${userText}」`);
    return NextResponse.json({ ok: true });
  }

  try {
    // --- ここから通常ルート ---
    // 1) CSV 読み込み
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

    // 3) LLM（Gemini）で要約を作る
    const listText = formatPharmaciesForPrompt(result);
    const systemPrompt = SYSTEM_PROMPT;

    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

    const res = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: systemPrompt },
            { text: `ユーザーの質問：${userText}` },
            { text: `候補薬局リスト：\n${listText}` },
          ],
        },
      ],
    });

    const aiText = res.response.text().trim() || listText; // 念のため

    await replyText(event.replyToken, aiText.slice(0, 4000)); // 文字数制限ケア
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("LINE webhook error", err);

    // ★ Gemini などでエラーになったときの保険
    await replyText(
      event.replyToken,
      "システム側でエラーが発生しました。時間をおいてもう一度お試しください。"
    );
    return NextResponse.json({ ok: false });
  }
}
