import ScheduleForm from "@/components/schedule-form";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Schedule a WhatsApp Message
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            The message is queued now and sent by a background worker at the exact
            scheduled time — you can close this tab.
          </p>
        </header>

        <ScheduleForm />

        <footer className="mt-10 text-xs text-slate-500">
          Times are scheduled in Asia/Kolkata (IST).
        </footer>
      </div>
    </main>
  );
}
