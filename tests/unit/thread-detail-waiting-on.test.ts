import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extraction, Item } from "@/lib/ai/schema";
import { toPayload } from "@/lib/extraction/payload";
import type { ExtractionView } from "@/lib/extraction/service";
import { processExtraction } from "@/lib/pipeline/proposals";
import { createFieldsFromPayload } from "@/lib/review/tray";
import type { ThreadDetail } from "@/lib/threads/read";
import { userNextAction } from "@/lib/threads/view";
import { setNowForTests } from "@/lib/time";

/**
 * Nov 7 production report: a paste of "Sam said he'll send the venue contract by Thursday." showed a
 * thread whose "About this" card read "What you need to do: Send the venue contract".
 *
 * A model answer that is correct under D63 (waiting_on, owner other, counterparty Sam) goes through
 * the real pipeline and Accept mapping, then the real thread detail page and Review Tray render.
 * Synthetic text only; no model call. Fix: a waiting_on loop's action is someone else's, so it is
 * never shown as the user's next action (userNextAction). Thread detail shows the user's own next
 * action as plain text with no `Suggested` tag: accepting the proposal confirmed it (coordinator,
 * Nov 8). The Review Tray card keeps `Suggested` for proposals not yet accepted.
 */

const NOW = "2026-11-07T15:00:00.000Z"; // Sat Nov 7, 2026, 10:00 in New York
const TZ = "America/New_York";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const SAM = "Sam said he'll send the venue contract by Thursday.";
const OWN = "I'll send Sam the seating plan by Friday.";
const ASKED = "Can you book the caterer by Tuesday?";

function item(over: Partial<Item> & Pick<Item, "type" | "owner" | "title" | "action" | "date_text" | "date_iso">, quote: string): Item {
  return {
    counterparty: null,
    amount_text: null,
    certainty: "explicit",
    uncertainty_notes: [],
    matches_thread_id: null,
    evidence: [{ quote, speaker: null }],
    ...over,
  };
}

const model = (source: string, it: Item): { source: string; out: Extraction } => ({
  source,
  out: { source_summary: "Synthetic note", participants: [], items: [it], brief: null },
});

/** Right by D63: someone else's promise to the user. */
const WAITING = model(
  SAM,
  item({ type: "waiting_on", owner: "other", counterparty: "Sam", title: "Venue contract from Sam", action: "Send the venue contract", date_text: "by Thursday", date_iso: "2026-11-12" }, SAM),
);
const COMMITMENT = model(
  OWN,
  item({ type: "commitment", owner: "user", counterparty: "Sam", title: "Send Sam the seating plan", action: "Send Sam the seating plan", date_text: "by Friday", date_iso: "2026-11-13" }, OWN),
);
const REQUEST = model(
  ASKED,
  item({ type: "request", owner: "user", title: "Book the caterer", action: "Book the caterer", date_text: "by Tuesday", date_iso: "2026-11-10" }, ASKED),
);

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), notFound: vi.fn() }));
vi.mock("@/app/review/[extractionId]/actions", () => ({
  acceptProposalsAction: vi.fn(),
  rejectProposalsAction: vi.fn(),
  undoRejectAction: vi.fn(),
  proposalsShownAction: vi.fn(),
  retryExtractionAction: vi.fn(),
}));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/components/threads/ThreadActions", () => ({ ThreadActions: () => null }));
vi.mock("@/components/threads/ForgetThread", () => ({ ForgetThread: () => null }));
vi.mock("@/components/threads/WhySheet", () => ({ WhyLink: () => null }));
vi.mock("@/components/threads/DecisionReason", () => ({ DecisionReason: () => null }));

function pipeline({ source, out }: { source: string; out: Extraction }) {
  const res = processExtraction(out, { sourceText: source, referenceDate: "2026-11-07", referenceDateSource: "defaulted", timezone: TZ, logger: () => {} });
  expect(res.proposals).toHaveLength(1);
  return res.proposals[0]!;
}

type Events = ThreadDetail["events"];

async function renderThread(m: { source: string; out: Extraction }, events: Events = []): Promise<string> {
  const proposal = pipeline(m);
  const fields = createFieldsFromPayload(toPayload(proposal), { sourceId: SOURCE_ID, confidence: proposal.score });
  expect(fields).not.toBeNull();
  detail = {
    thread: {
      id: THREAD_ID,
      title: fields!.title,
      kind: fields!.kind,
      status: fields!.kind === "waiting_on" ? "waiting" : "open",
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
    events,
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

async function renderTray(m: { source: string; out: Extraction }): Promise<string> {
  const proposal = pipeline(m);
  const view: ExtractionView = {
    id: "44444444-4444-4444-8444-444444444444",
    sourceId: SOURCE_ID,
    status: "succeeded",
    stage: null,
    slow: false,
    proposals: [{ id: "55555555-5555-4555-8555-555555555555", band: proposal.band as "high", confidence: proposal.score, reviewStatus: "pending", threadId: null, payload: toPayload(proposal) }],
    brief: null,
    error: null,
    retryAvailable: false,
    timedOut: false,
    elapsedMs: 0,
  };
  const { ReviewTray } = await import("@/components/review/ReviewTray");
  return renderToStaticMarkup(createElement(ReviewTray, { view, timezone: TZ, nowIso: NOW }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Text of the compact "About this" card. */
const aboutThis = (html: string) => text(html.match(/<section aria-labelledby="explain-title"[\s\S]*?<\/section>/)?.[0] ?? "");
/** Text of the top "Next action" section, or "" when it is not rendered. */
const nextActionSection = (html: string) => text(html.match(/<section aria-labelledby="next-action"[\s\S]*?<\/section>/)?.[0] ?? "");

beforeEach(() => setNowForTests(NOW));

describe("the pipeline keeps a reported promise someone else's (D63)", () => {
  it("waiting_on / owner other / Sam survives the pipeline, and Accept makes a waiting_on thread waiting on Sam", () => {
    const p = pipeline(WAITING);
    expect(p.item).toMatchObject({ type: "waiting_on", owner: "other", counterparty: "Sam", action: "Send the venue contract" });
    // Paste with no written-on date: "by Thursday" is read against today (defaulted) and marked inferred.
    expect(p.date).toMatchObject({ due_date: "2026-11-12", due_certainty: "inferred", agreement: "agree" });
    expect(p.not_sure).toEqual(['I read "by Thursday" as Thu Nov 12 (I assumed this was written today, Sat Nov 7). Change the date if that\'s wrong.']);
    expect(createFieldsFromPayload(toPayload(p), { sourceId: SOURCE_ID, confidence: p.score })).toMatchObject({
      kind: "waiting_on",
      waiting_on: "Sam",
      counterparty: "Sam",
      next_action: "Send the venue contract",
    });
  });

  it("a model that says commitment with owner other still maps to waiting_on (lib/threads/mapping.ts)", () => {
    const p = pipeline({ ...WAITING, out: { ...WAITING.out, items: [{ ...WAITING.out.items[0]!, type: "commitment" }] } });
    expect(createFieldsFromPayload(toPayload(p), { sourceId: SOURCE_ID, confidence: p.score })).toMatchObject({ kind: "waiting_on", waiting_on: "Sam" });
  });
});

describe("userNextAction", () => {
  it("hides a waiting_on action and keeps every other kind's", () => {
    expect(userNextAction("waiting_on", "Send the venue contract")).toBeNull();
    for (const kind of ["commitment", "request", "admin", "decision"] as const) expect(userNextAction(kind, "Do it")).toBe("Do it");
    expect(userNextAction("request", null)).toBeNull();
    expect(userNextAction("request", "  ")).toBeNull();
    expect(userNextAction(null, "Do it")).toBeNull(); // key_fact: no thread kind
  });
});

describe("thread detail", () => {
  it("waiting_on: Sam's action is not shown as the user's (no Next action, no What you need to do)", async () => {
    const html = await renderThread(WAITING);
    expect(nextActionSection(html)).toBe("");
    expect(aboutThis(html)).not.toContain("What you need to do");
    expect(html).not.toContain("Send the venue contract");
    // The header still says who and when; the compact card keeps By when and Not sure about.
    expect(text(html)).toMatch(/Waiting on · Sam/);
    expect(aboutThis(html)).toMatch(/^About this By when .*Not sure about/);
  });

  it("commitment (the user's own): Next action and What you need to do show it as plain text, no Suggested tag", async () => {
    const html = await renderThread(COMMITMENT);
    expect(nextActionSection(html)).toBe("Next action Send Sam the seating plan");
    expect(aboutThis(html)).toContain("What you need to do Send Sam the seating plan By when");
    // Accepted, so confirmed (coordinator, Nov 8): main's markup, no Interpretation voice and no Sparkle.
    expect(html).toContain('<p class="mt-1 text-body text-le-text">Send Sam the seating plan</p>');
    expect(html).toContain('<p class="mt-2 text-body text-le-text">Send Sam the seating plan</p>');
    expect(text(html)).not.toContain("Suggested");
    expect(html).not.toContain("lucide-sparkle");
  });

  it("request: shown as plain text, no Suggested tag", async () => {
    const html = await renderThread(REQUEST);
    expect(nextActionSection(html)).toBe("Next action Book the caterer");
    expect(aboutThis(html)).toContain("What you need to do Book the caterer");
    expect(text(html)).not.toContain("Suggested");
  });
});

describe("Review Tray card", () => {
  it("waiting_on: no Suggested action for Sam's promise; the loop type and Sam still show", async () => {
    const html = await renderTray(WAITING);
    expect(html).not.toContain("Send the venue contract");
    expect(text(html)).not.toContain("Suggested");
    expect(text(html)).toMatch(/Waiting on · Sam/);
  });

  it("commitment and request: the Suggested action still shows", async () => {
    expect(text(await renderTray(COMMITMENT))).toContain("Suggested Send Sam the seating plan");
    expect(text(await renderTray(REQUEST))).toContain("Suggested Book the caterer");
  });
});
