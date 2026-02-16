import VideoUploader from "@/components/VideoUploader";

export default function Home() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <main className="container mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-zinc-900 dark:text-zinc-50 mb-3">
            動画 → テキスト
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400 text-lg">
            MP4動画をアップロードすると、AIが自動で文字起こしします
          </p>
        </div>
        <VideoUploader />
      </main>
    </div>
  );
}
