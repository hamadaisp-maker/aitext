"use client";

import { useState, useRef, useCallback } from "react";

const PROMPT =
  "この音声を文字起こししてください。以下のルールに従ってください：\n" +
  "- タイムスタンプは不要\n" +
  "- 話者の区別は不要\n" +
  "- 「あー」「えー」「まあ」「えっと」などのフィラー（つなぎ言葉）はすべて省いてください\n" +
  "- 内容を省略せず、すべての発言を書き起こしてください\n" +
  "- 整った読みやすい文章として出力してください";

// 動画/音声からWAV音声を抽出（ブラウザのWeb Audio APIを使用）
async function extractAudioAsWav(file: File): Promise<Blob> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // モノラルに変換
  const numberOfChannels = 1;
  const length = audioBuffer.length;
  const sampleRate = 16000;
  const offlineContext = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineContext.destination);
  source.start();
  const renderedBuffer = await offlineContext.startRendering();

  // WAVに変換
  const wavBuffer = audioBufferToWav(renderedBuffer);
  await audioContext.close();
  return new Blob([wavBuffer], { type: "audio/wav" });
}

// AudioBufferをWAVバイナリに変換
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;
  const samples = buffer.getChannelData(0);
  const dataLength = samples.length * (bitsPerSample / 8);
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // PCM data
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return arrayBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export default function VideoUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [transcription, setTranscription] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((selectedFile: File) => {
    if (
      !selectedFile.type.startsWith("video/") &&
      !selectedFile.type.startsWith("audio/")
    ) {
      setError("動画または音声ファイル（MP4等）を選択してください。");
      return;
    }
    setFile(selectedFile);
    setError("");
    setTranscription("");
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) handleFile(droppedFile);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  // APIキーをサーバーから取得
  async function getApiKey(): Promise<string> {
    const res = await fetch("/api/upload", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.apiKey;
  }

  const handleSubmit = async () => {
    if (!file) return;

    setIsLoading(true);
    setError("");
    setTranscription("");

    try {
      // Step 1: APIキー取得
      setStatus("認証情報を取得中...");
      console.log("[Step 1] Getting API key...");
      const apiKey = await getApiKey();
      console.log("[Step 1] API key obtained.");

      // Step 2: 動画から音声を抽出
      setStatus("音声を抽出中...");
      console.log("[Step 2] Extracting audio from video...");
      const audioBlob = await extractAudioAsWav(file);
      console.log(`[Step 2] Audio extracted: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);

      // Step 3: base64変換してGeminiに送信
      setStatus("Gemini に送信中...");
      console.log("[Step 3] Converting to base64 and sending...");
      const audioArrayBuffer = await audioBlob.arrayBuffer();
      const base64Data = arrayBufferToBase64(audioArrayBuffer);
      console.log(`[Step 3] Base64 size: ${(base64Data.length / 1024 / 1024).toFixed(2)}MB`);

      const model = "gemini-3-pro-preview";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      setStatus("Gemini が文字起こし中...");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600000);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: "audio/wav",
                    data: base64Data,
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

      clearTimeout(timeoutId);
      const data = await res.json();

      if (!res.ok) {
        console.error("Gemini error:", JSON.stringify(data, null, 2));
        throw new Error(data.error?.message || "文字起こしに失敗しました。");
      }

      const text =
        data.candidates?.[0]?.content?.parts?.[0]?.text ??
        "文字起こし結果を取得できませんでした。";

      console.log("[Step 3] Transcription complete!");
      setTranscription(text);
      setStatus("");
    } catch (err) {
      console.error("Error:", err);
      if (err instanceof Error && err.name === "AbortError") {
        setError("タイムアウトしました。もう一度お試しください。");
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "文字起こし中にエラーが発生しました。"
        );
      }
      setStatus("");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(transcription);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const baseName = file
      ? file.name.replace(/\.[^.]+$/, "")
      : "transcription";
    const blob = new Blob([transcription], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setFile(null);
    setTranscription("");
    setError("");
    setStatus("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-6">
      {/* Upload Area */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all
          ${
            isDragOver
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
              : file
              ? "border-green-400 bg-green-50 dark:bg-green-950/20"
              : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
          className="hidden"
        />

        {file ? (
          <div className="space-y-2">
            <div className="text-4xl">🎬</div>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">
              {file.name}
            </p>
            <p className="text-sm text-zinc-500">{formatFileSize(file.size)}</p>
            <p className="text-xs text-zinc-400">
              クリックしてファイルを変更
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-5xl">📹</div>
            <p className="text-lg font-medium text-zinc-700 dark:text-zinc-300">
              動画ファイルをドラッグ＆ドロップ
            </p>
            <p className="text-sm text-zinc-500">
              またはクリックしてファイルを選択
            </p>
            <p className="text-xs text-zinc-400">
              MP4, MOV, AVI, WebM, MP3, WAV 対応
            </p>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleSubmit}
          disabled={!file || isLoading}
          className={`
            flex-1 py-3 px-6 rounded-lg font-medium text-white transition-all
            ${
              !file || isLoading
                ? "bg-zinc-300 dark:bg-zinc-700 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700 active:bg-blue-800"
            }
          `}
        >
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              文字起こし中...
            </span>
          ) : (
            "文字起こし開始"
          )}
        </button>
        {file && !isLoading && (
          <button
            onClick={handleReset}
            className="py-3 px-6 rounded-lg font-medium border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all"
          >
            リセット
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Loading Status */}
      {isLoading && status && (
        <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 space-y-2">
          <p className="font-medium">{status}</p>
          <p className="text-sm">
            動画の長さによって1〜3分程度かかります。
          </p>
        </div>
      )}

      {/* Result */}
      {transcription && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              文字起こし結果
            </h2>
            <div className="flex gap-2">
              <button
                onClick={handleDownload}
                className="text-sm py-1.5 px-4 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-all"
              >
                TXTダウンロード
              </button>
              <button
                onClick={handleCopy}
                className="text-sm py-1.5 px-4 rounded-md border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all"
              >
                {copied ? "コピーしました！" : "コピー"}
              </button>
            </div>
          </div>
          <div className="p-6 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200 max-h-[600px] overflow-y-auto">
            {transcription}
          </div>
        </div>
      )}
    </div>
  );
}
