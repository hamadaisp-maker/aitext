import { NextRequest, NextResponse } from "next/server";
import { writeFile, readFile, unlink, mkdir, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

// 1チャンクあたりの最大サイズ（15MB - base64にすると約20MBでAPI上限ギリギリ）
const MAX_CHUNK_BYTES = 15 * 1024 * 1024;
// 1チャンクあたりの音声時間（分）。64kbps mono → 約480KB/min → 30分で約14MB
const CHUNK_MINUTES = 30;

const PROMPT =
  "この音声を文字起こししてください。以下のルールに従ってください：\n" +
  "- タイムスタンプは不要\n" +
  "- 話者の区別は不要\n" +
  "- 「あー」「えー」「まあ」「えっと」などのフィラー（つなぎ言葉）はすべて省いてください\n" +
  "- 内容を省略せず、すべての発言を書き起こしてください\n" +
  "- 整った読みやすい文章として出力してください";

const PROMPT_CONTINUATION =
  "この音声は長い音声の続きです。前のパートに続けて文字起こししてください。以下のルールに従ってください：\n" +
  "- タイムスタンプは不要\n" +
  "- 話者の区別は不要\n" +
  "- 「あー」「えー」「まあ」「えっと」などのフィラー（つなぎ言葉）はすべて省いてください\n" +
  "- 内容を省略せず、すべての発言を書き起こしてください\n" +
  "- 整った読みやすい文章として出力してください\n" +
  "- 前のパートとの接続は気にせず、この音声の内容だけを書き起こしてください";

async function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vn",
    "-acodec", "libmp3lame",
    "-ab", "64k",
    "-ar", "16000",
    "-ac", "1",
    "-y",
    audioPath,
  ]);
}

async function splitAudio(
  audioPath: string,
  tempDir: string,
  timestamp: number
): Promise<string[]> {
  const audioStat = await stat(audioPath);
  const audioSize = audioStat.size;

  // 分割不要ならそのまま返す
  if (audioSize <= MAX_CHUNK_BYTES) {
    return [audioPath];
  }

  // ffprobeで音声の長さを取得
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    audioPath,
  ]);
  const totalDuration = parseFloat(stdout.trim());
  const chunkDuration = CHUNK_MINUTES * 60;
  const numChunks = Math.ceil(totalDuration / chunkDuration);

  console.log(
    `Audio: ${(audioSize / 1024 / 1024).toFixed(1)}MB, ` +
    `${(totalDuration / 60).toFixed(1)}min → ${numChunks} chunks`
  );

  const chunkPaths: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const startTime = i * chunkDuration;
    const chunkPath = join(tempDir, `chunk-${timestamp}-${i}.mp3`);

    await execFileAsync("ffmpeg", [
      "-i", audioPath,
      "-ss", String(startTime),
      "-t", String(chunkDuration),
      "-acodec", "libmp3lame",
      "-ab", "64k",
      "-ar", "16000",
      "-ac", "1",
      "-y",
      chunkPath,
    ]);

    if (existsSync(chunkPath)) {
      chunkPaths.push(chunkPath);
    }
  }

  return chunkPaths;
}

async function transcribeChunk(
  apiKey: string,
  audioBuffer: Buffer,
  isFirstChunk: boolean
): Promise<string> {
  const base64Audio = audioBuffer.toString("base64");
  const model = "gemini-3-pro-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: "audio/mpeg",
                data: base64Audio,
              },
            },
            {
              text: isFirstChunk ? PROMPT : PROMPT_CONTINUATION,
            },
          ],
        },
      ],
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

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_api_key_here") {
    return NextResponse.json(
      { error: "GEMINI_API_KEY が設定されていません。.env.local を確認してください。" },
      { status: 500 }
    );
  }

  const tempDir = join(tmpdir(), "totext-uploads");
  const timestamp = Date.now();
  const tempFiles: string[] = [];

  try {
    const formData = await request.formData();
    const file = formData.get("video") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "動画ファイルが見つかりません。" },
        { status: 400 }
      );
    }

    if (!file.type.startsWith("video/")) {
      return NextResponse.json(
        { error: "動画ファイル（MP4等）をアップロードしてください。" },
        { status: 400 }
      );
    }

    // Save video to temp file
    await mkdir(tempDir, { recursive: true });
    const videoPath = join(tempDir, `video-${timestamp}.mp4`);
    const audioPath = join(tempDir, `audio-${timestamp}.mp3`);
    tempFiles.push(videoPath, audioPath);

    const bytes = await file.arrayBuffer();
    await writeFile(videoPath, Buffer.from(bytes));

    // Extract audio with ffmpeg
    console.log("Extracting audio...");
    await extractAudio(videoPath, audioPath);
    console.log("Audio extracted.");

    // Split audio if needed
    const chunkPaths = await splitAudio(audioPath, tempDir, timestamp);
    tempFiles.push(...chunkPaths.filter((p) => p !== audioPath));

    console.log(`Processing ${chunkPaths.length} chunk(s)...`);

    // Transcribe each chunk
    const results: string[] = [];
    for (let i = 0; i < chunkPaths.length; i++) {
      console.log(`Transcribing chunk ${i + 1}/${chunkPaths.length}...`);
      const chunkBuffer = await readFile(chunkPaths[i]);
      console.log(`Chunk ${i + 1} size: ${(chunkBuffer.length / 1024).toFixed(0)} KB`);
      const text = await transcribeChunk(apiKey, chunkBuffer, i === 0);
      results.push(text);
    }

    const transcription = results.join("\n\n");

    return NextResponse.json({
      transcription,
      chunks: chunkPaths.length,
    });
  } catch (error) {
    console.error("Transcription error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "文字起こし中にエラーが発生しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    // Clean up all temp files
    for (const p of tempFiles) {
      try { await unlink(p); } catch { /* ignore */ }
    }
  }
}
