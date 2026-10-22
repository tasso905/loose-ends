"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileUp } from "lucide-react";
import { submitUpload } from "@/app/add/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { ErrorBanner, FieldError, InfoNotice } from "@/components/Notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { TITLE_MAX_CHARS } from "@/lib/capture/pasteInput";
import { formatFileSize, SOURCES_BUCKET, UPLOAD_ACCEPT, UPLOAD_COPY, UPLOAD_MAX_BYTES, type UploadField } from "@/lib/capture/uploadInput";
import { apiError, type ApiError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { TitleField, WrittenOnField } from "./SourceFields";

type Failure = ApiError["error"];

/**
 * Upload mode (F3; SITE_CONTRACT §2.2, DESIGN_STANDARD "File drop zone"). One file, picked or
 * dropped. A file over 10 MB is refused here before anything is sent. Otherwise the file goes
 * straight to the private bucket at sources/{uid}/{source_id} with the user's session (storage RLS),
 * then submitUpload() sniffs and reads it on the server. Only when the server confirms the source
 * exists does the page move to /review/[id] (rule 10). Type, page count and scan checks happen on
 * the server, from the file's bytes.
 */
export function UploadForm({ today, userId }: { today: string; userId: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [writtenOn, setWrittenOn] = useState(today);
  const [writtenOnSet, setWrittenOnSet] = useState(false);
  const [titleLength, setTitleLength] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [failedField, setFailedField] = useState<UploadField | null>(null);
  const [pending, startTransition] = useTransition();

  // SITE_CONTRACT §3.2: focus the first relevant field on /add (here, the file picker).
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) inputRef.current?.focus();
  }, []);

  function choose(next: File | null) {
    setFailure(null);
    setFailedField(null);
    if (next && next.size > UPLOAD_MAX_BYTES) {
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setFailure(apiError("file_too_large", { sizeMb: next.size / (1024 * 1024) }).error);
      setFailedField("file");
      return;
    }
    setFile(next);
  }

  // After Remove, focus returns to the picker once the drop zone is back (never to <body>).
  const focusPicker = useRef(false);
  useEffect(() => {
    if (!focusPicker.current || file) return;
    focusPicker.current = false;
    inputRef.current?.focus();
  }, [file]);

  function remove() {
    if (inputRef.current) inputRef.current.value = "";
    focusPicker.current = true;
    choose(null);
  }

  function chooseAnother() {
    remove();
    inputRef.current?.click();
  }

  const serverField = (f: UploadField) => (failure && failedField === f ? failure : null);
  const fileError = serverField("file");
  const titleError =
    titleLength > TITLE_MAX_CHARS ? apiError("invalid_input", { field: "title" }).error.message : (serverField("title")?.message ?? null);
  const dateError = serverField("written_on")?.message ?? null;
  const banner = failure && !failedField ? failure : null;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !file || titleLength > TITLE_MAX_CHARS) return;
    const form = new FormData(e.currentTarget);
    form.delete("file");
    setFailure(null);
    setFailedField(null);
    startTransition(async () => {
      if (!navigator.onLine) {
        setFailure(apiError("offline").error);
        return;
      }
      try {
        // A new id per attempt: a refused or failed attempt's file is removed by the server.
        const sourceId = crypto.randomUUID();
        const supabase = createClient();
        const up = await supabase.storage
          .from(SOURCES_BUCKET)
          // Stored as opaque bytes: the type is sniffed on the server, never trusted from the browser.
          .upload(`${userId}/${sourceId}`, file, { contentType: "application/octet-stream", upsert: false });
        if (up.error) {
          const status = Number((up.error as { statusCode?: string | number }).statusCode);
          if (status === 413) {
            setFailure(apiError("file_too_large", { sizeMb: file.size / (1024 * 1024) }).error);
            setFailedField("file");
          } else {
            setFailure(apiError(navigator.onLine ? "save_failed" : "offline").error);
          }
          return;
        }
        form.set("source_id", sourceId);
        form.set("file_name", file.name);
        const result = await submitUpload(form);
        if (result.ok) {
          router.push(`/review/${result.extractionId}`);
          return;
        }
        if (result.signedOut) {
          router.push(`/sign-in?next=${encodeURIComponent("/add?mode=upload")}`);
          return;
        }
        setFailure(result.error);
        setFailedField(result.field ?? null);
      } catch {
        setFailure(apiError(navigator.onLine ? "save_failed" : "offline").error);
      }
    });
  }

  const scan = fileError?.code === "unsupported_scan";

  return (
    <form method="post" onSubmit={onSubmit} aria-busy={pending || undefined} className="mt-6 space-y-5">
      {banner ? (
        <ErrorBanner
          action={
            banner.retryable ? (
              <Button type="submit" variant="secondary" size="small" disabled={pending}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {banner.message}
        </ErrorBanner>
      ) : null}

      <div>
        {/* Kept out of the zone so it stays rendered (and clickable) while the chosen-file row shows. */}
        <input
          ref={inputRef}
          id="file"
          name="file"
          type="file"
          accept={UPLOAD_ACCEPT}
          tabIndex={file ? -1 : undefined}
          // Named here too: the zone (its <label>) is hidden while the chosen-file row shows.
          aria-label="Drop a file or choose one"
          className="peer sr-only"
          onChange={(e) => choose(e.currentTarget.files?.[0] ?? null)}
          aria-invalid={fileError && !scan ? true : undefined}
          aria-describedby={["file-hint", fileError ? "file-error" : null].filter(Boolean).join(" ")}
        />
        <label
          htmlFor="file"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const dropped = e.dataTransfer.files;
            if (dropped.length > 0) choose(dropped[0] ?? null);
          }}
          className={cn(
            "flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-le-border-strong bg-le-surface-sunken px-4 py-6 text-center",
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-le-accent",
            dragOver && "border-2 border-solid border-le-accent bg-le-accent-subtle",
            fileError && !scan && "border-le-danger-fg",
            file && "hidden",
          )}
        >
          <FileUp aria-hidden strokeWidth={1.75} className="size-5 text-le-text-secondary" />
          <span className="text-body text-le-text">Drop a file or choose one</span>
          <span id="file-hint" className="text-small text-le-text-secondary">
            {UPLOAD_COPY.dropHint}
          </span>
        </label>

        {file ? (
          <div className="flex min-h-11 items-center gap-3 rounded-card border border-le-border bg-le-surface px-4 py-3">
            <FileUp aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-le-text-secondary" />
            <span className="min-w-0 flex-1 truncate text-body text-le-text">{file.name}</span>
            <span className="text-small text-le-text-secondary tabular-nums">{formatFileSize(file.size)}</span>
            <Button type="button" variant="ghost" size="small" aria-label={`Remove ${file.name}`} disabled={pending} onClick={remove}>
              {UPLOAD_COPY.remove}
            </Button>
          </div>
        ) : null}

        {fileError && scan ? (
          <InfoNotice className="mt-3">
            <p id="file-error" role="alert">
              {fileError.message}
            </p>
            <Link href="/add?mode=paste" className={cn(buttonVariants({ variant: "secondary", size: "small" }), "mt-2")}>
              Paste the text instead
            </Link>
          </InfoNotice>
        ) : fileError ? (
          <div className="mt-1 space-y-2">
            <FieldError id="file-error">{fileError.message}</FieldError>
            <Button type="button" variant="secondary" size="small" onClick={chooseAnother}>
              Choose another file
            </Button>
          </div>
        ) : null}
      </div>

      <WrittenOnField
        today={today}
        value={writtenOn}
        set={writtenOnSet}
        error={dateError}
        onChange={(v) => {
          setWrittenOn(v);
          setWrittenOnSet(true);
          if (failedField === "written_on") setFailure(null);
        }}
      />

      <TitleField
        error={titleError}
        onInput={(n) => {
          setTitleLength(n);
          if (failedField === "title") setFailure(null);
        }}
      />

      <Button type="submit" disabled={!hydrated || pending || !file || titleLength > TITLE_MAX_CHARS}>
        {pending ? <Spinner /> : null}
        Review source
      </Button>
    </form>
  );
}
