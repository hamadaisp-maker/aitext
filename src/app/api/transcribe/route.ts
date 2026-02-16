import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const maxDuration = 300;

const PROMPT =
  "この音声/動画を文字起こししてください。以下のルールに従ってください：\n" +
  "- タイムスタンプは不要\n" +
  "- 話者の区別は不要\n" +
  "- 「あー」「えー」「まあ」「えっと」などのフィラー（つなぎ言葉）はすべて省いてください\n" +
  "- 内容を省略せず、すべての発言を書き起こしてください\n" +
  "- 整った読みやすい文章として出力してください";

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY が設定されていません。" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await request.json();
    const { fileUri, mimeType } = body;

    if (!fileUri || !mimeType) {
      return new Response(
        JSON.stringify({ error: "fileUri と mimeType が必要です。" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("Transcribing file:", fileUri, mimeType);

    const ai = new GoogleGenAI({ apiKey });

    // ファイルの状態を確認
    const fileName = fileUri.split("/").pop();
    let fileInfo = await ai.files.get({ name: `files/${fileName}` });

    // ACTIVEになるまで待つ
    let attempts = 0;
    while (fileInfo.state === "PROCESSING" && attempts < 60) {
      console.log(`File state: ${fileInfo.state}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await ai.files.get({ name: `files/${fileName}` });
      attempts++;
    }

    if (fileInfo.state !== "ACTIVE") {
      throw new Error(`ファイルの状態が不正です: ${fileInfo.state}`);
    }

    console.log("File is ACTIVE. Starting transcription...");

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: fileUri,
                mimeType: mimeType,
              },
            },
            {
              text: PROMPT,
            },
          ],
        },
      ],
      config: {
        maxOutputTokens: 65536,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const transcription = response.text ?? "文字起こし結果を取得できませんでした。";
    console.log("Transcription complete.");

    return new Response(
      JSON.stringify({ transcription }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Transcription error:", error);
    const message =
      error instanceof Error ? error.message : "文字起こし中にエラーが発生しました。";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
