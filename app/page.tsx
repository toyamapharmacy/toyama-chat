// app/page.tsx
"use client";

import Image from "next/image";
import { useState, KeyboardEvent } from "react";

type Provider = "openai" | "gemini";
type Message = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState<Provider>("openai");
  const [loading, setLoading] = useState(false);

  async function handleSend() {
    if (!input.trim() || loading) return;

    const nextMessages: Message[] = [
      ...messages,
      { role: "user", content: input },
    ];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    const apiPath = provider === "openai" ? "/api/chat" : "/api/chat-gemini";

    try {
      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();

      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          // どちらのモデルか分かるように頭にマークを付けても OK
          content: data.reply as string,
          // content: `【${provider}】${data.reply as string}`,
        },
      ]);
    } catch (e) {
      console.error(e);
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content:
            "すみません、サーバー側でエラーが発生しました。時間をおいて再度お試しください。",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // Enter で送信、変換中は送信しない
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const native = e.nativeEvent as any;
    if (native.isComposing || native.keyCode === 229) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* ヘッダー */}
      <header className="flex items-center justify-between px-4 py-3 bg-white shadow-sm">
        <div className="flex items-center gap-2">
          <Image src="/logo.png" width={160} height={160} alt="logo" />
          <div>
            <div className="font-semibold">Toyama Chat</div>
            <div className="text-xs text-slate-500">
              富山市 薬局ナビ AI（ベータ版）
            </div>
          </div>
        </div>

        {/* モデル切り替えスイッチ */}
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span>モデル:</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              value="openai"
              checked={provider === "openai"}
              onChange={() => setProvider("openai")}
            />
            <span>OpenAI</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              value="gemini"
              checked={provider === "gemini"}
              onChange={() => setProvider("gemini")}
            />
            <span>Gemini</span>
          </label>
        </div>
      </header>

      {/* チャット欄 */}
      <main className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${
              m.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-blue-500 text-white rounded-br-sm"
                  : "bg-white text-slate-800 border border-slate-200 rounded-bl-sm"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
      </main>

      {/* 入力欄 */}
      <footer className="px-3 py-2 bg-white border-t border-slate-200">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-full border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
            placeholder="例）堀川エリアで在宅対応の薬局"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="px-4 py-2 rounded-full bg-blue-500 text-white text-sm font-medium disabled:opacity-60"
            onClick={handleSend}
            disabled={loading}
          >
            {loading ? "送信中..." : "送信"}
          </button>
        </div>
      </footer>
    </div>
  );
}
