// 1 行分のデータ型
export type Row = Record<string, string>;
;


/* ================= System prompt ================= */

export const SYSTEM_PROMPT = `
あなたは「富山市薬局ナビAI」です。
富山市および周辺エリア（呉羽・婦中・水橋・大沢野・大久保・速星・八尾・岩瀬・山室・奥田・五福など）の薬局情報を案内するアシスタントです。

▼役割
- 薬局の所在地・電話番号・営業時間・在宅対応・麻薬注射・無菌調剤・抗原検査キット・緊急避妊薬などを、
  登録データに基づき「正確に」「わかりやすく」案内します。
- 回答の根拠は、常に渡された薬局一覧データのみとし、推測や創作はしません。

▼基本ルール
- 推測でものを言わない。「このデータには載っていません」と正直に答える。
- 検索結果が複数ある場合は最大5件まで案内する。
- 同名の薬局が複数ある場合は、地域名と住所を併記して区別する。
- 地域指定がない場合でも特に補正は行わず、与えられたリストの内容を公平に扱う。
+ - 該当件数が5件を超える場合は、「ほかにも条件に合う薬局があります。地域名やサービス条件（在宅・麻薬・緊急避妊など）を追加して質問すると、さらに絞り込めます。」と必ず一言添える。

▼出力フォーマットの例
【1】○○薬局
・住所：富山市○○○○
・電話：076-xxx-xxxx
・営業時間：月9:00-18:00 / 火9:00-18:00 …
・サービス：オンライン / 在宅 / 麻薬 / 無菌調剤 / 抗原検査 / 緊急避妊 …

▼トーン
- 丁寧・親切・落ち着いた口調。
- 方言（富山弁）は使わない。
- 語尾は「〜です」「〜できます」「〜をご確認ください」を基本とし、
  地元の案内人のように、親しみやすく、しかし公的な案内としての信頼感を保つ。
`;

/* ================= サービスタグ定義 ================= */

export const SERVICE_TAGS: { tag: string; keywords: string[] }[] = [
  {
    tag: "オンライン",
    keywords: ["オンライン", "オンライン服薬指導", "オンライン診療"],
  },
  {
    tag: "抗原",
    keywords: [
      "抗原",
      "抗原検査",
      "抗原検査キット",
      "検査キット",
      "検査薬",
      "コロナ",
      "コロナ検査",
      "インフル",
      "インフルエンザ",
    ],
  },
  {
    tag: "在宅",
    keywords: ["在宅", "訪問", "在宅医療", "往診", "訪問対応"],
  },
  { tag: "麻薬", keywords: ["麻薬", "麻薬注射"] },
  { tag: "無菌調剤", keywords: ["無菌", "無菌調剤", "無菌製剤"] },
  {
    tag: "緊急避妊",
    keywords: [
      "避妊",
      "緊急避妊",
      "緊急避妊薬",
      "アフターピル",
      "モーニングアフターピル",
      "ピル",
    ],
  },
  // 土曜 在宅
  {
    tag: "土曜在宅",
    keywords: [
      "土曜在宅",
      "土曜日在宅",
      "土曜に在宅",
      "土曜日に在宅",
      "土曜日 在宅対応",
      "土曜 在宅対応",
    ],
  },
  // 土曜 外来
  {
    tag: "土曜外来",
    keywords: [
      "土曜外来",
      "土曜日外来",
      "土曜に開いている薬局",
      "土曜日に開いている薬局",
      "土曜日 開いている薬局",
    ],
  },
];


/* ================= タグ関連ヘルパー ================= */

// 「;」「／」「、」区切りを配列に
export function parseTagList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;／、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 検索用：総合タグ＋曜日タグ_外来＋曜日タグ_在宅
export function getTags(row: Row): string[] {
  const baseRaw = (row["総合タグ"] ?? "") as string;
  const weekdayOutRaw = (row["曜日タグ_外来"] ?? "") as string;
  const weekdayHomeRaw = (row["曜日タグ_在宅"] ?? "") as string;

  const tags: string[] = [];

  parseTagList(baseRaw).forEach((t) => tags.push(t));

  parseTagList(weekdayOutRaw).forEach((day) => {
    if (!day) return;
    tags.push(`${day}外来`);
  });

  parseTagList(weekdayHomeRaw).forEach((day) => {
    if (!day) return;
    tags.push(`${day}在宅`);
  });

  return [...new Set(tags)];
}

// 表示用：曜日がくっついたタグは除外
export function getDisplayTags(row: Row): string[] {
  const tags = getTags(row);
  return tags.filter((t) => {
    if (t.match(/[月火水木金土日]曜外来/)) return false;
    if (t.match(/[月火水木金土日]曜在宅/)) return false;
    if (t.match(/^[月火水木金土日]曜$/)) return false;
    return true;
  });
}

// 営業時間：ヘッダー名から動的に探して
// 「月9:00-18:00 / 火9:00-18:00 …」の形に整形する
export function getOpeningHours(row: Row): string {
  // 行のヘッダー一覧を取得
  const keys = Object.keys(row);

  // 「この曜日っぽいヘッダー」を探すための定義
  const dayDefs: { label: string; patterns: string[] }[] = [
    { label: "月", patterns: ["月曜", "月曜日"] },
    { label: "火", patterns: ["火曜", "火曜日"] },
    { label: "水", patterns: ["水曜", "水曜日"] },
    { label: "木", patterns: ["木曜", "木曜日"] },
    { label: "金", patterns: ["金曜", "金曜日", "平日"] },
    { label: "土", patterns: ["土曜", "土曜日"] },
    { label: "日", patterns: ["日曜", "日曜日"] },
    { label: "祝", patterns: ["祝日", "祝祭日"] },
  ];

  const parts: string[] = [];

  for (const day of dayDefs) {
    // その曜日の列を、ヘッダー名からゆるく検索
    const colKey = keys.find((k) => {
      if (!k.includes("開局時間")) return false;
      return day.patterns.some((p) => k.includes(p));
    });

    if (!colKey) continue;

    let v = (row[colKey] ?? "") as string;
    if (!v) continue;

    // 空欄記号などを弾きたい場合はここで調整
    if (v === "-" || v === "－") continue;

    // 改行やスペースを詰める
    v = v.replace(/\s+/g, "");

    parts.push(`${day.label}${v}`);
  }

  return parts.join(" / ");
}

// 電話番号をいい感じに拾う
export function getTel(row: Row): string {
  const priorityKeys = [
    "電話番号",
    "TEL",
    "連絡先電話番号",
    "連絡先電話番号（開局中）",
  ];

  for (const key of priorityKeys) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }

  const phoneRegex = /0\d{1,4}-\d{1,4}-\d{3,4}/;

  for (const [key, value] of Object.entries(row)) {
    if (!/電話|TEL/i.test(key)) continue;
    if (typeof value !== "string") continue;
    const m = value.match(phoneRegex);
    if (m) return m[0];
  }

  for (const value of Object.values(row)) {
    if (typeof value !== "string") continue;
    const m = value.match(phoneRegex);
    if (m) return m[0];
  }

  return "";
}

/* ================= CSV 読み込み ================= */

export function splitCsvLine(line: string): string[] {
  return line.split(",");
}

export function cleanCell(v: string | undefined | null): string {
  if (v == null) return "";
  return String(v).replace(/^"|"$/g, "").trim();
}

// 改行入りセル・"" 付きの CSV を安全にパースする簡易パーサー
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  // CRLF / LF をそのまま処理したいので文字ごとに走査
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      const next = text[i + 1];

      if (inQuotes && next === '"') {
        // "" → エスケープされた "
        currentField += '"';
        i++; // 1 文字読み飛ばす
      } else {
        // クォートの開始 / 終了
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      // フィールド終了
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      // 行終了（\r\n 連結も考慮）
      // 直前が \r で、今回が \n の場合は 2 回行終端にならないように調整
      if (ch === "\n" && text[i - 1] === "\r") {
        continue;
      }
      currentRow.push(currentField);
      currentField = "";

      if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    // それ以外の文字はそのままフィールドへ
    currentField += ch;
  }

  // 最後のフィールド・行を追加
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length === 0) return [];

  // 1 行目をヘッダーとして扱う
  const headers = rows[0].map((h) => h.trim().replace(/^"|"$/g, ""));
  const records: Row[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const obj: Row = {};
    headers.forEach((h, idx) => {
      const v = cols[idx] ?? "";
      obj[h] = typeof v === "string" ? v.trim().replace(/^"|"$/g, "") : "";
    });
    records.push(obj);
  }

  return records;
}

/* ================= 質問文の前処理 ================= */

export function tokenizeQuery(qRaw: string): string[] {
  let q = qRaw;

  // 先に曜日を抽出して絶対残す
const MUST_KEEP = ["日曜","日曜日","土曜","土曜日","祝日","平日","休日"];

for (const keep of MUST_KEEP) {
  q = q.replace(new RegExp(keep, "g"), ` ${keep} `);
}

  const stopPhrases = [
    "について教えて",
    "について知りたい",
    "について",
    "を教えて",
    "が知りたい",
    "知りたい",
    "教えて",
    "の店舗を知りたい",
    "の店舗",
    
  ];

  // 余計なフレーズをスペースに置き換え
  for (const p of stopPhrases) {
    q = q.replace(new RegExp(p, "g"), " ");
  }

  // 句読点・助詞をスペースに
  q = q
    .replace(/[、。.,，]/g, " ")
    .replace(/[ではがをにへとってからまでよりへで]/g, " ");

  // 「薬局」「ドラッグストア」など汎用語を削る
  const genericWords = ["薬局", "店舗", "店", "薬"];
  for (const g of genericWords) {
    q = q.replace(new RegExp(g, "g"), " ");
  }

  // いったん生の単語リストを作成（◯◯エリア → ◯◯）
  const rawWords = q
    .split(/\s+/)
    .map((w) => w.replace(/(エリア|地域|周辺|付近)$/, "") )// 末尾の「エリア」を削る
    .filter(Boolean);

  // 「地域・周辺・近く・あたり・付近」はノイズとして捨てる
  const noiseWords = ["地域", "周辺", "近く", "あたり", "付近"];

  const words = rawWords
    .filter((w) => !noiseWords.includes(w))
    // 「富山市内」「高岡市」「○○町」→「富山」「高岡」「○○」
    .map((w) => w.replace(/(市内|市|町|村|区)$/, "")
  )
    .filter(Boolean);

  return words;
}

// 店名比較用：余計な言葉や空白を削る
export function normalizeForNameCompare(text: string): string {
  let s = text;

  const removePhrases = [
    "について教えて",
    "について知りたい",
    "について",
    "を教えて",
    "が知りたい",
    "知りたい",
    "教えて",
    "の店舗を知りたい",
    "の店舗",
    "開いている",
    "開いてる",
    "空いている",
    "空いてる",
    "やっている",
    "やってる",
    "営業している",
    "営業中",
  ];
  for (const p of removePhrases) {
    s = s.replace(new RegExp(p, "g"), "");
  }

  const genericWords = ["薬局", "店舗", "店", "薬"];
  for (const g of genericWords) {
    s = s.replace(new RegExp(g, "g"), "");
  }

  s = s.replace(/\s+/g, "");
  return s.trim();
}

/* ================= 曜日判定 ================= */

// ▼曜日のゆらぎ対応
const WEEKDAY_MAP = [
  { canonical: "月曜", keywords: ["月曜", "月曜日"] },
  { canonical: "火曜", keywords: ["火曜", "火曜日"] },
  { canonical: "水曜", keywords: ["水曜", "水曜日"] },
  { canonical: "木曜", keywords: ["木曜", "木曜日"] },
  { canonical: "金曜", keywords: ["金曜", "金曜日", "平日"] },
  { canonical: "土曜", keywords: ["土曜", "土曜日"] },
  { canonical: "日曜", keywords: ["日曜", "日曜日"] },
  { canonical: "祝日", keywords: ["祝日", "祭日"] }, // ← 祝日も追加
];

export function detectWeekday(word: string): string | null {
  for (const w of WEEKDAY_MAP) {
    if (w.keywords.some((kw) => word.includes(kw))) {
      return w.canonical;
    }
  }
  return null;
}

/* ================= クエリ解析 ================= */

// 「○○薬局△△店」のような名前をざっくり拾う
export function detectChainName(qRaw: string): string | null {
  const m = qRaw.match(/(.+?薬局)/);
  if (!m) return null;
  return m[1].trim();
}

/* ================= 検索本体 ================= */

export function extractConditions(qRaw: string) {
 
  const words = tokenizeQuery(qRaw);

  const requestedTags: string[] = []; // 在宅 / 抗原 / 緊急避妊 など
  const freeWords: string[] = [];     // 地域名など
  const weekdayTags: string[] = [];   // 月曜 / 土曜 / 祝日 など

  let hasDrugstoreWord = false;

  for (const w of words) {
    // ① 曜日かどうか判定
    const wd = detectWeekday(w);
    if (wd) {
      if (!weekdayTags.includes(wd)) {
        weekdayTags.push(wd);
      }
      // 曜日は freeWords には入れない
      continue;
    }

     // ② 「ドラッグストア」系キーワード判定 ★ 追加
    if (
      w.includes("ドラッグストア") ||
      w.includes("ドラッグ") 
    ) {
      hasDrugstoreWord = true;
      continue; // 地域ワードには入れない
    }

    // ② サービスタグ（在宅 / 抗原 / オンライン …）
    let matchedTag: string | null = null;
    for (const svc of SERVICE_TAGS) {
      if (svc.keywords.some((k) => w.includes(k))) {
        matchedTag = svc.tag;
        break;
      }
    }

    if (matchedTag) {
      if (!requestedTags.includes(matchedTag)) {
        requestedTags.push(matchedTag);
      }
    } else {
      // ③ どちらでもなければフリーワード（地域名など）
      freeWords.push(w);
    }
  }

  return { requestedTags, freeWords, weekdayTags, hasDrugstoreWord };
}
/* ---------- 検索本体 ---------- */

export function searchPharmacies(records: Row[], qRaw: string) {
  const { requestedTags, freeWords, weekdayTags, hasDrugstoreWord } =
    extractConditions(qRaw);
  // 以降、hasDrugstoreWord を使ってドラッグストア絞り込み…

  // 在宅条件が含まれているか？
  const needHome = requestedTags.includes("在宅");

  // 地域名などに使うワード（曜日系は extractConditions で除外済み）
  const addressWords = [...freeWords];

  // 住所・地域・薬局名に対するフィルタ
  const filterOnce = (rows: Row[], words: string[]): Row[] => {
    if (words.length === 0) return rows;

    return rows.filter((row) => {
      const area = row["地域"] ?? "";
      const addr = row["住所"] ?? row["所在地"] ?? "";
      const name = row["薬局名"] ?? "";
      const targetText = `${area} ${addr} ${name}`;
      return words.every((w) => w && targetText.includes(w));
    });
  };

  // ① 地域フィルタ
  let filtered = filterOnce(records, addressWords);

  if (filtered.length === 0 && addressWords.length === 0) {
    // 地域指定なし → 全件スタート
    filtered = records;
  } else if (filtered.length === 0 && addressWords.length > 0) {
    // 地域指定ありで 0件 → 1語だけでゆるめ検索
    filtered = filterOnce(records, [addressWords[0]]);
  }

  // ② サービスタグ（在宅 / 抗原 / 無菌調剤 …）で絞り込み
  if (requestedTags.length > 0) {
    filtered = filtered.filter((row) => {
      const tags = getTags(row); // 総合タグ＋曜日タグ_外来＋曜日タグ_在宅
      return requestedTags.every((tag) => tags.includes(tag));
    });
  }

  // ③ 曜日で絞り込み
  if (weekdayTags.length > 0) {
    if (needHome) {
      // 「日曜 在宅」など → 在宅の曜日タグを参照
      filtered = filtered.filter((row) => {
        const y = (row["曜日タグ_在宅"] ?? "") as string;
        return weekdayTags.every((wd) => y.includes(wd));
      });
    } else {
      // 「日曜日に開いている薬局」など → 外来の曜日タグを参照
      filtered = filtered.filter((row) => {
        const y = (row["曜日タグ_外来"] ?? "") as string;
        return weekdayTags.every((wd) => y.includes(wd));
      });
    }
  }

// ③.5 「ドラッグストア」と指定された場合は、ドラッグストア系チェーンだけに絞り込み
  if (hasDrugstoreWord) {
    const DRUGSTORE_CHAINS = [
      "ウエルシア",
      "Vドラッグ",
      "Ｖドラッグ",
      "クスリのアオキ",
      "ドラッグセイムス",
      "シメノドラッグ",
      "スギ薬局",
      "マツモトキヨシ",
    ];

    filtered = filtered.filter((row) => {
      const name = (row["薬局名"] ?? "") as string;
      return DRUGSTORE_CHAINS.some((kw) => name.includes(kw));
    });
  }

  // ④ 地域 → 薬局名 でソート
  const sorted = [...filtered].sort((a, b) => {
    const areaA = (a["地域"] ?? "").toString();
    const areaB = (b["地域"] ?? "").toString();
    if (areaA !== areaB) {
      return areaA.localeCompare(areaB, "ja");
    }

    const nameA = (a["薬局名"] ?? "").toString();
    const nameB = (b["薬局名"] ?? "").toString();
    return nameA.localeCompare(nameB, "ja");
  });

  return { result: sorted, requestedTags, freeWords };
}
/* ================= 表示用フォーマット ================= */
// 単一店舗に対する回答フォーマット
export function answerForSinglePharmacy(row: Row, title: string): string {
  const address = (row["住所"] ?? row["所在地"] ?? "") as string;
  const tel = getTel(row);

  // 営業時間は getOpeningHours だけを使う（ここをシンプルに）
  const hours = getOpeningHours(row);          // 月9:00-… / 火9:00-… など

  // サービス（曜日付きタグは除外）
  const servicesArr = getDisplayTags(row);     // 在宅 / 抗原 / 麻薬 など
  const services = servicesArr.join(" / ");

  // ★ デバッグ（あとで不要になったら消してOK）
  console.log("DEBUG single:", row["薬局名"], { hours, servicesArr });

  const lines: string[] = [];

  // タイトル
  lines.push(`【1】 ${title}`);

  if (address) {
    lines.push(`・住所：${address}`);
  }
  if (tel) {
    lines.push(`・電話：${tel}`);
  }
  if (hours) {
    lines.push(`・営業時間：${hours}`);
  }
  if (services) {
    lines.push(`・サービス：${services}`);
  }

  return lines.join("\n");
}


// 複数店舗（最大5件）を LLM に渡す用
export function formatPharmaciesForPrompt(rows: Row[]): string {
  const top5 = rows.slice(0, 5);

  return top5
    .map((row, idx) => {
      const name = (row["薬局名"] ?? "") as string;
      const address = ((row["住所"] ?? row["所在地"] ?? "") as string).trim();
      const tel = getTel(row);
      const hours = getOpeningHours(row);
      const services = getDisplayTags(row).join(" / ");

      const lines: string[] = [];
      lines.push(`【${idx + 1}】 ${name}`);
      if (address) lines.push(`・住所：${address}`);
      if (tel) lines.push(`・電話：${tel}`);
      if (hours) lines.push(`・営業時間：${hours}`);
      if (services) lines.push(`・サービス：${services}`);

      return lines.join("\n");
    })
    .join("\n\n");
}
