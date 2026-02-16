import { NextRequest, NextResponse } from "next/server";

const PROMPT =
  "この音声/動画を文字起こししてください。以下のルールに従ってください：\n" +
  "- タイムスタンプは不要\n" +
  "- 話者の区別は不要\n" +
  "- 「あー」「えー」「まあ」「えっと」などのフィラー（つなぎ言葉）はすべて省いてください\n" +
  "- 内容を省略せず、すべての発言を書き起こしてください\n" +
  "- 整った読みやすい文章として出力してください";

// ファイルの処理状態を確認（ACTIVEになるまで待つ）
async function waitForFileActive(
  apiKey: string,
  fileUri: string
): Promise<void> {
  const fileName = fileUri.split("/").pop();
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/files/${fileName}?key=${apiKey}`
    );
    const data = await res.json();

    if (data.state === "ACTIVE") {
      return;
    } else if (data.state === "FAILED") {
      throw new Error("ファイルの処理に失敗しました。");
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("ファイルの処理がタイムアウトしました。");
}

// Geminiで文字起こし
async function transcribeWithGemini(
  apiKey: string,
  fileUri: string,
  mimeType: string
): Promise<string> {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              fileData: {
                mimeType: mimeType,
                fileUri: fileUri,
              },
            },
            {
              text: PROMPT,
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 65536,
      },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Gemini error:", JSON.stringify(data, null, 2));
    throw new Error(data.error?.message || "文字起こしに失敗しました。");
  }

  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text ??
    "文字起こし結果を取得できませんでした。"
  );
}

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_api_key_here") {
    return NextResponse.json(
      { error: "GEMINI_API_KEY が設定されていません。" },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const { fileUri, mimeType } = body;

    if (!fileUri || !mimeType) {
      return NextResponse.json(
        { error: "fileUri と mimeType が必要です。" },
        { status: 400 }
      );
    }

    // ファイルがACTIVEになるまで待つ
    console.log("Waiting for file processing...", fileUri);
    await waitForFileActive(apiKey, fileUri);
    console.log("File is active.");

    // 文字起こし実行
    console.log("Starting transcription...");
    const transcription = await transcribeWithGemini(apiKey, fileUri, mimeType);
    console.log("Transcription complete.");

    return NextResponse.json({
      transcription,
      chunks: 1,
    });
  } catch (error) {
    console.error("Transcription error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "文字起こし中にエラーが発生しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
