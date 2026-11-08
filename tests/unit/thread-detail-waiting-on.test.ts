import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extraction } from "@/lib/ai/schema";
import { toPayload } from "@/lib/extraction/payload";
import { processExtraction } from "@/lib/pipeline/proposals";
import { createFieldsFromPayload } from "@/lib/review/tray";
import type { ThreadDetail } from "@/lib/threads/read";
import { setNowForTests } from "@/lib/time";

/**
 * Investigation (Nov 7): a production paste of "Sam said he'll send the venue contract by Thursday."
 * showed a thread whose "About this" card read "What you need to do: Send the venue contract".
 *
 * This file follows a model answer that is correct under D63 (waiting_on, owner other, counterparty
 * Sam) through the real pipeline and Accept mapping, then renders the real thread detail page.
 * Synthetic text only; no model call. The pipeline keeps type and owner, and the thread is
 * `waiting_on` / `waiting`. The page still labels the model's `action` as the user's task, so the
 * wrong card appears even when the model is right. The `it.fails` cases mark that UI bug: they pass
 * while the bug is there, and fail (so must be turned into `it`) once it is fixed.
 */

const SOURCE = "Sam said he'll send the venue contract by Thursday.";
const NOW = "2026-11-07T15:00:00.000Z"; // Sat Nov 7, 2026, 10:00 in New York
const TZ = "America/New_York";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

/** A model answer that is right by D63. */
const CORRECT_MODEL: Extraction = {
  source_summary: "Note about the venue contract",
  participants: [{ name: "Sam", is_user: "no" }],
  items: [
    {
      type: "waiting_on",
      title: "Venue contract from Sam",
      owner: "other",
      counterparty: "Sam",
      action: "Send the venue contract",
      date_text: "by Thursday",
      date_iso: "2026-11-12",
      amount_text: null,
      certainty: "explicit",
      uncertainty_notes: [],
      matches_thread_id: null,
      evidence: [{ quote: SOURCE, speaker: null }],
    },
  ],
  brief: null,
};

let detail: ThreadDetail;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => ({ id: "33333333-3333-4333-8333-333333333333" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/threads/read", () => ({
  getThreadDetail: async () => ({ ok: true, detail }),
  userTimezone: async () => TZ,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/components/threads/ThreadActions", () => ({ ThreadActions: () => null }));
vi.mock("@/components/threads/ForgetThread", () => ({ ForgetThread: () => null }));
vi.mock("@/components/threads/WhySheet", () => ({ WhyLink: () => null }));
vi.mock("@/components/threads/DecisionReason", () => ({ DecisionReason: () => null }));

function pipeline(model: Extraction) {
  const out = processExtraction(model, { sourceText: SOURCE, referenceDate: "2026-11-07", referenceDateSource: "defaulted", timezone: TZ, logger: () => {} });
  expect(out.proposals).toHaveLength(1);
  return out.proposals[0]!;
}

async function renderThread(model: Extraction): Promise<string> {
  const proposal = pipeline(model);
  const payload = toPayload(proposal);
  const fields = createFieldsFromPayload(payload, { sourceId: SOURCE_ID, confidence: proposal.score });
  expect(fields).not.toBeNull();
  const status = fields!.kind === "waiting_on" ? "waiting" : "open";
  detail = {
    thread: {
      id: THREAD_ID,
      title: fields!.title,
      kind: fields!.kind,
      status,
      due_at: fields!.due_at,
      due_certainty: fields!.due_certainty,
      due_time_known: fields!.due_time_known,
      snoozed_until: null,
      resolved_at: null,
      updated_at: NOW,
      created_at: NOW,
      next_action: fields!.next_action,
      counterparty: fields!.counterparty,
      waiting_on: fields!.waiting_on,
      expected_by: fields!.expected_by,
      resolution: null,
      primary_source_id: SOURCE_ID,
    },
    evidence: [],
    events: [],
    origin: { band: proposal.band, label: proposal.label },
    sources: {},
    brief: null,
    notSure: proposal.not_sure,
    decision: null,
  };
  const { default: ThreadPage } = await import("@/app/threads/[id]/page");
  const tree = await ThreadPage({ params: Promise.resolve({ id: THREAD_ID }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(tree);
}

/** Text of the compact "About this" card, tags stripped. */
function aboutThis(html: string): string {
  const m = html.match(/<section aria-labelledby="explain-title"[\s\S]*?<\/section>/);
  return (m?.[0] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("Nov 7 investigation: a reported promise by someone else (D63)", () => {
  beforeEach(() => setNowForTests(NOW));

  it("the pipeline keeps waiting_on / owner other / Sam, and Accept makes a waiting_on thread waiting on Sam", () => {
    const p = pipeline(CORRECT_MODEL);
    expect(p.item).toMatchObject({ type: "waiting_on", owner: "other", counterparty: "Sam", action: "Send the venue contract" });
    // Paste with no written-on date: "by Thursday" is read against today (defaulted) and marked inferred.
    expect(p.date).toMatchObject({ due_date: "2026-11-12", due_certainty: "inferred", agreement: "agree" });
    expect(p.not_sure).toEqual(['I read "by Thursday" as Thu Nov 12 (I assumed this was written today, Sat Nov 7). Change the date if that\'s wrong.']);
    const fields = createFieldsFromPayload(toPayload(p), { sourceId: SOURCE_ID, confidence: p.score });
    expect(fields).toMatchObject({ kind: "waiting_on", waiting_on: "Sam", counterparty: "Sam", next_action: "Send the venue contract" });
  });

  it("even a model that says commitment with owner other still maps to waiting_on (lib/threads/mapping.ts)", () => {
    const p = pipeline({ ...CORRECT_MODEL, items: [{ ...CORRECT_MODEL.items[0]!, type: "commitment" }] });
    expect(createFieldsFromPayload(toPayload(p), { sourceId: SOURCE_ID, confidence: p.score })).toMatchObject({ kind: "waiting_on", waiting_on: "Sam" });
  });

  it("the page reproduces the production card from a correct model answer", async () => {
    const html = await renderThread(CORRECT_MODEL);
    expect(html).toContain("Waiting on");
    expect(aboutThis(html)).toContain("About this What you need to do Send the venue contract By when");
    expect(aboutThis(html)).toContain("Not sure about");
  });

  it.fails("UI bug: a waiting_on thread owned by someone else is not labelled as the user's task in About this", async () => {
    expect(aboutThis(await renderThread(CORRECT_MODEL))).not.toContain("What you need to do");
  });

  it.fails("UI bug: the top Next action line does not present Sam's action as the user's own", async () => {
    expect(await renderThread(CORRECT_MODEL)).not.toMatch(/Next action<\/h2><p[^>]*>Send the venue contract/);
  });
});
