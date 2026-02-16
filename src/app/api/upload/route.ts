import { NextResponse } from "next/server";

// クライアントにアップロード用の情報を返す
export async function POST() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_api_key_here") {
    return NextResponse.json(
      { error: "GEMINI_API_KEY が設定されていません。" },
      { status: 500 }
    );
  }

  return NextResponse.json({ apiKey });
}
