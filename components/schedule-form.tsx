"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CreateMessageResponse,
  ApiError,
  ListMessagesResponse,
  MessageListItem,
} from "@/lib/types";

/**
 * The whole UI: one form, one submit button, plus the confirmation panel and a
 * list of scheduled/sent messages. No routing, no state library, no extra
 * pages — the brief asked for a simple single-page interface.
 */

const EMPTY = {
  recipientName: "",
  phoneNumber: "",
  messageContent: "",
  scheduledDate: "",
  scheduledTime: "",
};

type FormState = typeof EMPTY;
type FieldErrors = Partial<Record<keyof FormState, string>>;

export default function ScheduleForm() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<CreateMessageResponse["message"] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  /**
   * Earliest selectable date. Reading the clock during render would block
   * static prerendering (and mismatch between server and client), so it is
   * produced inside an effect and stored in state.
   */
  const [minDate, setMinDate] = useState<string | undefined>(undefined);
  useEffect(() => {
    void Promise.resolve().then(() => setMinDate(todayInIndia()));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/messages?limit=20", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load messages");
      const data = (await response.json()) as ListMessagesResponse;
      setMessages(data.messages);
      setListError(null);
    } catch {
      setListError("Could not load scheduled messages.");
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Initial load. Wrapped in a microtask so the first fetch resolves outside
  // the effect body — React 19's lint rule flags synchronous setState there,
  // and it would also cause a cascading render on mount.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setSuccess(null);
    setFailure(null);
    setErrors({});

    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = (await response.json()) as CreateMessageResponse | ApiError;

      if (!response.ok) {
        const error = data as ApiError;
        if (error.fields) setErrors(error.fields as FieldErrors);
        setFailure(error.error ?? "Could not schedule the message.");
        return;
      }

      setSuccess((data as CreateMessageResponse).message);
      setForm(EMPTY);
      await refresh();
    } catch {
      setFailure("Network error — could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(id: string) {
    setCancelingId(id);
    try {
      const response = await fetch(`/api/messages/${id}/cancel`, { method: "POST" });
      if (!response.ok) {
        const data = (await response.json()) as ApiError;
        setFailure(data.error ?? "Could not cancel the message.");
      }
      await refresh();
    } catch {
      setFailure("Network error — could not cancel the message.");
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        noValidate
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="space-y-5">
          <Field label="Recipient name" id="recipientName" error={errors.recipientName}>
            <input
              id="recipientName"
              type="text"
              autoComplete="name"
              maxLength={120}
              value={form.recipientName}
              onChange={(e) => update("recipientName", e.target.value)}
              placeholder="Rahul Sharma"
              className={inputClass(errors.recipientName)}
            />
          </Field>

          <Field
            label="Mobile number"
            id="phoneNumber"
            error={errors.phoneNumber}
            hint="Include the country code, e.g. +919876543210"
          >
            <input
              id="phoneNumber"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={form.phoneNumber}
              onChange={(e) => update("phoneNumber", e.target.value)}
              placeholder="+919876543210"
              className={inputClass(errors.phoneNumber)}
            />
          </Field>

          <Field label="Message" id="messageContent" error={errors.messageContent}>
            <textarea
              id="messageContent"
              rows={4}
              maxLength={4096}
              value={form.messageContent}
              onChange={(e) => update("messageContent", e.target.value)}
              placeholder="Hi Rahul, this is a reminder about your appointment tomorrow at 10:30 AM."
              className={`${inputClass(errors.messageContent)} resize-y`}
            />
            <div className="mt-1 text-right text-xs text-slate-400">
              {form.messageContent.length}/4096
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Scheduled date" id="scheduledDate" error={errors.scheduledDate}>
              <input
                id="scheduledDate"
                type="date"
                value={form.scheduledDate}
                min={minDate}
                onChange={(e) => update("scheduledDate", e.target.value)}
                className={inputClass(errors.scheduledDate)}
              />
            </Field>

            <Field
              label="Scheduled time"
              id="scheduledTime"
              error={errors.scheduledTime}
              hint="24-hour clock, IST"
            >
              <input
                id="scheduledTime"
                type="time"
                value={form.scheduledTime}
                onChange={(e) => update("scheduledTime", e.target.value)}
                className={inputClass(errors.scheduledTime)}
              />
            </Field>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Scheduling…" : "Schedule Message"}
        </button>
      </form>

      {success && <SuccessPanel message={success} onDismiss={() => setSuccess(null)} />}
      {failure && <FailurePanel message={failure} onDismiss={() => setFailure(null)} />}

      <MessageList
        messages={messages}
        loading={loadingList}
        error={listError}
        cancelingId={cancelingId}
        onCancel={handleCancel}
        onRefresh={refresh}
      />
    </div>
  );
}

function MessageList({
  messages,
  loading,
  error,
  cancelingId,
  onCancel,
  onRefresh,
}: {
  messages: MessageListItem[];
  loading: boolean;
  error: string | null;
  cancelingId: string | null;
  onCancel: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-sm font-medium text-slate-900">Scheduled &amp; sent messages</h2>
        <button
          onClick={onRefresh}
          className="text-xs text-slate-500 transition hover:text-slate-900"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>}
      {error && !loading && (
        <p className="px-5 py-6 text-sm text-red-600">{error}</p>
      )}
      {!loading && !error && messages.length === 0 && (
        <p className="px-5 py-6 text-sm text-slate-500">
          No messages yet. Schedule one above.
        </p>
      )}

      {messages.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {messages.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {m.recipientName}
                  </span>
                  <StatusBadge status={m.status} />
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{m.phoneNumber}</p>
                <p className="mt-1 text-xs text-slate-600">{m.scheduledAtLabel} IST</p>

                {/* Receipts: only claim what a webhook actually proved. */}
                <p className="mt-1 text-xs text-slate-500">{describeReceipts(m)}</p>

                {m.failureReason && (
                  <p className="mt-1 text-xs text-red-600">{m.failureReason}</p>
                )}
              </div>

              {canCancel(m.status) && (
                <button
                  onClick={() => onCancel(m.id)}
                  disabled={cancelingId === m.id}
                  className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                >
                  {cancelingId === m.id ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function describeReceipts(m: MessageListItem): string {
  const parts: string[] = [];
  if (m.sentAt) parts.push(`Sent ${time(m.sentAt)}`);
  if (m.deliveredAt) parts.push(`Delivered ${time(m.deliveredAt)}`);
  if (m.readAt) parts.push(`Read ${time(m.readAt)}`);
  if (parts.length === 0) {
    if (m.status === "CANCELED") return "Cancelled — will not be sent.";
    if (m.status === "FAILED") return "Not sent.";
    return "Waiting to send.";
  }
  if (m.deliveredAt && !m.readAt) {
    parts.push("read receipt not received (status unknown)");
  }
  return parts.join(" · ");
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function canCancel(status: string): boolean {
  return status === "PENDING" || status === "QUEUED";
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-700",
  QUEUED: "bg-blue-50 text-blue-700",
  SENDING: "bg-amber-50 text-amber-700",
  SENT: "bg-indigo-50 text-indigo-700",
  DELIVERED: "bg-teal-50 text-teal-700",
  READ: "bg-emerald-50 text-emerald-700",
  FAILED: "bg-red-50 text-red-700",
  CANCELED: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"
      }`}
    >
      {status}
    </span>
  );
}

function SuccessPanel({
  message,
  onDismiss,
}: {
  message: CreateMessageResponse["message"];
  onDismiss: () => void;
}) {
  return (
    <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-emerald-900">Message scheduled ✓</p>
          <dl className="mt-3 space-y-1 text-emerald-800">
            <Row label="Recipient" value={message.recipientName} />
            <Row label="Number" value={message.phoneNumber} />
            <Row label="Sends at" value={message.scheduledAtLabel} />
            <Row label="Timezone" value={message.timezone} />
            <Row label="Status" value={message.status} />
          </dl>
          <p className="mt-3 text-xs text-emerald-700">
            You can close this page — the background worker will send it at the scheduled time.
          </p>
        </div>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-emerald-600 hover:text-emerald-900">
          ✕
        </button>
      </div>
    </div>
  );
}

function FailurePanel({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
      <div className="flex items-start justify-between gap-4">
        <p className="text-red-800">{message}</p>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-red-600 hover:text-red-900">
          ✕
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  id,
  error,
  hint,
  children,
}: {
  label: string;
  id: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-emerald-700">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function inputClass(error?: string) {
  return [
    "w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition",
    "placeholder:text-slate-400 focus:ring-2",
    error
      ? "border-red-400 focus:border-red-500 focus:ring-red-200"
      : "border-slate-300 focus:border-slate-500 focus:ring-slate-200",
  ].join(" ");
}

/** Today's date in Asia/Kolkata, for the date input's `min`. */
function todayInIndia(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
