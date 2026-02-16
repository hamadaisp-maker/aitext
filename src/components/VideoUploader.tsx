"use client";

import { useState, useRef, useCallback } from "react";

const PROMPT =
  "この音声/動画を文字起こししてください。以下のルールに従ってください：\n" +
  "- タイムスタンプは不要\n" +
  "- 話者の区別は不要\n" +
  "- 「あー」「えー」「まあ」「えっと」などのフィラー（つなぎ言葉）はすべて省いてください\n" +
  "- 内容を省略せず、すべての発言を書き起こしてください\n" +
  "- 整った読みやすい文章として出力してください";

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

  // Gemini File APIにアップロード
  async function uploadToGemini(apiKey: string, file: File): Promise<string> {
    // Step 1: Resumable upload を開始
    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(file.size),
          "X-Goog-Upload-Header-Content-Type": file.type,
        },
        body: JSON.stringify({
          file: { displayName: file.name },
        }),
      }
    );

    const uploadUrl = startRes.headers.get("X-Goog-Upload-URL");
    if (!uploadUrl) {
      throw new Error("アップロードURLの取得に失敗しました。");
    }

    // Step 2: ファイルデータをアップロード
    const arrayBuffer = await file.arrayBuffer();
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(file.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: arrayBuffer,
    });

    const uploadData = await uploadRes.json();
    const fileUri = uploadData?.file?.uri;

    if (!fileUri) {
      throw new Error("ファイルのアップロードに失敗しました。");
    }

    return fileUri;
  }

  // ファイルがACTIVEになるまで待つ
  async function waitForFileActive(
    apiKey: string,
    fileUri: string
  ): Promise<void> {
    const fileName = fileUri.split("/").pop();
    const maxAttempts = 120;

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

      await new Promise((resolve) => setTimeout(resolve, 3000));
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

  const handleSubmit = async () => {
    if (!file) return;

    setIsLoading(true);
    setError("");
    setTranscription("");

    try {
      // Step 1: APIキー取得
      setStatus("認証情報を取得中...");
      const apiKey = await getApiKey();

      // Step 2: Gemini File APIにアップロード
      setStatus("ファイルをアップロード中...");
      const fileUri = await uploadToGemini(apiKey, file);

      // Step 3: ファイル処理完了を待つ
      setStatus("ファイルを処理中...");
      await waitForFileActive(apiKey, fileUri);

      // Step 4: 文字起こし
      setStatus("Gemini が文字起こし中...");
      const text = await transcribeWithGemini(apiKey, fileUri, file.type);

      setTranscription(text);
      setStatus("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "文字起こし中にエラーが発生しました。"
      );
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
            動画の長さによって数分かかることがあります。
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
