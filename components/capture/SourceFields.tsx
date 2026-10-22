"use client";
import { FieldError } from "@/components/Notice";
import { Input } from "@/components/ui/input";
import { formatWrittenOn } from "@/lib/capture/pasteInput";

/**
 * The optional source fields shared by Paste and Upload (SITE_CONTRACT §2.2, D47): the written-on
 * date (defaults to today, `Assumed`) and the title, each collapsed under its disclosure.
 */

export function WrittenOnField({
  today,
  value,
  set,
  error,
  onChange,
}: {
  today: string;
  value: string;
  /** True once the user picked a date. */
  set: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <details className="group" open={error ? true : undefined}>
      <summary className="focus-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-control text-body-strong text-le-text md:min-h-0">
        When was this written?
        <span className="text-small font-normal text-le-text-secondary tabular-nums">{formatWrittenOn(value, today)}</span>
        {!set ? <AssumedChip /> : null}
      </summary>
      <div className="mt-3">
        <label htmlFor="written_on" className="block text-small text-le-text-secondary">
          {set ? "Written on" : "I assumed this was written today. Change it if it wasn't."}
        </label>
        <Input
          id="written_on"
          name="written_on"
          type="date"
          value={value}
          required
          min="1900-01-01"
          max="2100-12-31"
          onChange={(e) => {
            if (!e.currentTarget.value) return;
            onChange(e.currentTarget.value);
          }}
          className="mt-2 w-auto tabular-nums"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "written-on-error" : undefined}
        />
        {error ? <FieldError id="written-on-error">{error}</FieldError> : null}
        <input type="hidden" name="written_on_set" value={set ? "1" : "0"} readOnly />
      </div>
    </details>
  );
}

export function TitleField({ error, onInput }: { error: string | null; onInput: (trimmedLength: number) => void }) {
  return (
    <details open={error ? true : undefined}>
      <summary className="focus-ring flex min-h-11 cursor-pointer items-center rounded-control text-body-strong text-le-text md:min-h-0">
        Add a title
      </summary>
      <div className="mt-3">
        <label htmlFor="title" className="block text-small text-le-text-secondary">
          Title (optional)
        </label>
        <Input
          id="title"
          name="title"
          autoComplete="off"
          className="mt-2"
          onInput={(e) => onInput(e.currentTarget.value.trim().length)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "title-error" : undefined}
        />
        {error ? <FieldError id="title-error">{error}</FieldError> : null}
      </div>
    </details>
  );
}

/** `Assumed` chip: dotted 1px --border-strong outline, no icon (DESIGN_STANDARD Due chip). */
export function AssumedChip() {
  return (
    <span className="inline-flex h-6 items-center rounded-control border border-dotted border-le-border-strong px-2 text-label text-le-text-secondary">
      Assumed
    </span>
  );
}
