import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatDue } from "@/lib/dates";
import type { ProposalPayloadV1 } from "@/lib/extraction/payload";
import type { ExtractionView, ProposalView } from "@/lib/extraction/service";
import { confidenceLabel } from "@/lib/pipeline/score";
import { bandCounts, canAccept, groupProposals, initialSelection, TRAY_COPY, trayProposals } from "@/lib/review/tray";
import type { Band, ReviewStatus } from "@/lib/schemas";

// ReviewTray is a client component; its server actions and the router are stubbed (nothing is
// called during a static render).
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/review/[extractionId]/actions", () => ({
  acceptProposalsAction: vi.fn(),
  rejectProposalsAction: vi.fn(),
  undoRejectAction: vi.fn(),
  proposalsShownAction: vi.fn(),
  retryExtractionAction: vi.fn(),
}));
const { ReviewTray } = await import("@/components/review/ReviewTray");

const SOURCE = "11111111-1111-4111-8111-111111111111";
let seq = 0;

function payload(over: {
  title: string;
  type?: ProposalPayloadV1["item"]["type"];
  owner?: ProposalPayloadV1["item"]["owner"];
  counterparty?: string | null;
  band: Band;
  quote: string;
  dueAt?: string | null;
  certainty?: "explicit" | "inferred" | "none";
  notSure?: string[];
  label?: { word: string; reason: string } | null;
}): ProposalPayloadV1 {
  const dueAt = over.dueAt ?? null;
  return {
    v: 1,
    item: {
      type: over.type ?? "commitment",
      title: over.title,
      owner: over.owner ?? "user",
      counterparty: over.counterparty === undefined ? "Mike" : over.counterparty,
      action: "Send the revised proposal",
      date_text: dueAt ? "Friday" : null,
      date_iso: null,
      amount_text: null,
      certainty: "explicit",
      uncertainty_notes: [],
      matches_thread_id: null,
    },
    evidence: [
      { quote: over.quote, speaker: null, start_offset: 0, end_offset: over.quote.length, page: null, match_kind: "exact", similarity: 1, quote_hash: "h" },
    ],
    date: {
      due_at: dueAt,
      due_date: dueAt ? dueAt.slice(0, 10) : null,
      due_time_known: false,
      due_certainty: dueAt ? (over.certainty ?? "explicit") : "none",
      agreement: dueAt ? "agree" : "none",
      not_sure: [],
      reasoning: dueAt ? 'I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).' : null,
    },
    score: 0.9,
    band: over.band,
    signals: [],
    label: over.label === undefined ? (over.band === "ignore" ? null : confidenceLabel(over.type ?? "commitment", over.band, ["date_agrees"])) : over.label,
    not_sure: over.notSure ?? [],
  };
}

function proposal(p: ProposalPayloadV1, reviewStatus: ReviewStatus = "pending"): ProposalView {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    band: p.band as ProposalView["band"],
    confidence: p.score,
    reviewStatus,
    threadId: null,
    payload: p,
  };
}

const LIKELY = proposal(payload({ title: "Send revised proposal to Mike", band: "high", quote: "I'll send you the revised proposal Friday", dueAt: "2026-10-10T03:59:00.000Z" }));
const MAYBE = proposal(payload({ title: "Call the plumber", band: "medium", quote: "I could call the plumber", dueAt: "2026-10-10T03:59:00.000Z", certainty: "inferred", notSure: ['I read "Friday" as Fri Oct 9. Check this date.'] }));
const LOW = proposal(
  payload({
    title: "Lunch with Mike",
    type: "intention",
    band: "low",
    quote: "We should grab lunch sometime",
    label: confidenceLabel("intention", "low", ["hedge_words", "no_date"]),
  }),
);
const IGNORE = proposal(payload({ title: "Quokka ignore item", band: "ignore", quote: "Maybe I could look at the budget" }));
const KEY_FACT = proposal(payload({ title: "Policy number fact", type: "key_fact", band: "high", quote: "Policy number 123" }));
const WAITING_NOBODY = proposal(payload({ title: "Contract back", type: "waiting_on", counterparty: null, band: "high", quote: "the contract should come back" }));

const ALL = [LOW, IGNORE, MAYBE, KEY_FACT, LIKELY];

describe("grouping and pre-check rules (F6, D3)", () => {
  it("groups Likely → Maybe → Also noticed; Ignore and key_fact are never in the tray", () => {
    const groups = groupProposals(ALL);
    expect(groups.map((g) => [g.title, g.collapsed, g.items.map((i) => i.payload.item.title)])).toEqual([
      ["Likely", false, ["Send revised proposal to Mike"]],
      ["Maybe", false, ["Call the plumber"]],
      ["Also noticed", true, ["Lunch with Mike"]],
    ]);
    expect(trayProposals(ALL)).not.toContain(IGNORE);
    expect(trayProposals(ALL)).not.toContain(KEY_FACT);
  });

  it("empty groups are left out", () => {
    expect(groupProposals([LOW]).map((g) => g.title)).toEqual(["Also noticed"]);
    expect(groupProposals([IGNORE, KEY_FACT])).toEqual([]);
  });

  it("only pending, acceptable Likely items are pre-checked; Maybe and Also noticed never are", () => {
    const rejectedLikely = { ...LIKELY, id: "00000000-0000-4000-8000-0000000000ff", reviewStatus: "rejected" as const };
    const sel = initialSelection([...ALL, rejectedLikely, WAITING_NOBODY], SOURCE);
    expect([...sel]).toEqual([LIKELY.id]);
  });

  it("a waiting-on item with nobody named cannot be accepted (transition needs waiting_on)", () => {
    expect(canAccept(WAITING_NOBODY, SOURCE)).toBe(false);
    expect(canAccept(LIKELY, SOURCE)).toBe(true);
    expect(canAccept(LOW, SOURCE)).toBe(true);
    expect(canAccept(KEY_FACT, SOURCE)).toBe(false);
  });

  it("band counts cover only what the tray shows", () => {
    expect(bandCounts(ALL)).toEqual({ high: 1, medium: 1, low: 1 });
  });
});

describe("label copy (SITE_CONTRACT §2.4, F19, D10)", () => {
  it("heading, result line and actions", () => {
    expect(TRAY_COPY.heading(1)).toBe("I found 1 thing in this");
    expect(TRAY_COPY.heading(3)).toBe("I found 3 things in this");
    expect(TRAY_COPY.resultCount(1)).toBe("1 thread added");
    expect(TRAY_COPY.resultCount(2)).toBe("2 threads added");
    expect(TRAY_COPY.viewInToday).toBe("View in Today");
    expect(TRAY_COPY.zero).toBe("Nothing here needs your attention");
    expect([TRAY_COPY.acceptSelected, TRAY_COPY.rejectAll, TRAY_COPY.reject, TRAY_COPY.rejected, TRAY_COPY.undo]).toEqual([
      "Accept selected",
      "Reject all",
      "Reject",
      "Rejected",
      "Undo",
    ]);
    expect(TRAY_COPY.assumed).toBe("Assumed");
    expect(TRAY_COPY.suggested).toBe("Suggested");
  });

  it("confidence labels: three words only, with a reason", () => {
    expect(confidenceLabel("commitment", "high", ["date_agrees"])).toEqual({ word: "Likely", reason: "Clear commitment with a date." });
    expect(confidenceLabel("intention", "low", ["hedge_words", "no_date"])).toEqual({
      word: "Also noticed",
      reason: "Possible intention detected, but I'm not confident enough to remind you.",
    });
    expect(confidenceLabel("commitment", "medium", ["no_date"])?.word).toBe("Maybe");
    expect(confidenceLabel("commitment", "ignore", [])).toBeNull();
  });
});

const NOW_ISO = "2026-10-05T15:00:00.000Z";
function view(proposals: ProposalView[], brief: unknown = null): ExtractionView {
  return { id: "33333333-3333-4333-8333-333333333333", sourceId: SOURCE, status: "succeeded", stage: null, slow: false, proposals, brief, error: null, retryAvailable: false, timedOut: false, elapsedMs: 0 };
}
const render = (v: ExtractionView) => renderToStaticMarkup(createElement(ReviewTray, { view: v, timezone: "America/New_York", nowIso: NOW_ISO }));

describe("ReviewTray render", () => {
  const html = render(view(ALL));

  it("never renders Ignore or key_fact items", () => {
    expect(html).not.toContain("Quokka ignore item");
    expect(html).not.toContain("Policy number fact");
    expect(html).toContain("I found 3 things in this");
  });

  it("Likely is checked, Maybe is not, Also noticed is collapsed and unchecked", () => {
    const checkboxes = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]).toContain('checked=""');
    expect(checkboxes[1]).not.toContain("checked");
    expect(checkboxes[2]).not.toContain("checked");
    expect(html).toMatch(/<details class="mt-8"><summary[^>]*>.*Also noticed \(1\)<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("each card: dot + word + reason, serif quote, Assumed chip, Not sure about, Reject", () => {
    expect(html).toContain("Likely</span><span>· Clear commitment with a date.</span>");
    expect(html).toContain("Possible intention detected, but I&#x27;m not confident enough to remind you.");
    expect(html).toMatch(/<blockquote class="[^"]*font-serif[^"]*">I&#x27;ll send you the revised proposal Friday<\/blockquote>/);
    expect(html.match(/>Assumed</g)).toHaveLength(1);
    expect(html).toContain("Not sure about");
    expect(html).toContain("Due Fri");
    expect(html.match(/>Reject<\/button>/g)).toHaveLength(3);
    expect(html).toContain("Accept selected");
    expect(html).toContain("Reject all");
  });

  it("a rejected item shows Rejected · Undo and no checkbox", () => {
    const out = render(view([{ ...LIKELY, reviewStatus: "rejected" }]));
    expect(out).toContain("Rejected ·");
    expect(out).toContain(">Undo</button>");
    expect(out).not.toContain('type="checkbox"');
  });

  it("accepted items are counted in the result line and not shown as cards", () => {
    const out = render(view([{ ...LIKELY, reviewStatus: "accepted" }, LOW]));
    expect(out).toContain("1 thread added");
    expect(out).toContain('href="/today"');
    expect(out).not.toContain("Send revised proposal to Mike");
  });

  it("zero items shows the brief, with source lines as quotes and interpretation labelled", () => {
    const brief = {
      what_this_is: [{ text: "A renewal notice", basis: "source", quote: "Your policy renews on October 31", match: null }],
      what_to_do: [{ text: "Compare quotes", basis: "interpretation", quote: null, match: null }],
      by_when: [{ text: "unverified", basis: "source", quote: null, match: null }],
      if_you_dont: [],
      worth_considering: [],
      not_sure_about: ["Whether the price includes tax"],
    };
    const out = render(view([IGNORE], brief));
    expect(out).toContain("Nothing here needs your attention");
    expect(out).toMatch(/font-serif[^>]*>Your policy renews on October 31</);
    expect(out).toContain(">Interpretation<");
    expect(out).toContain("Compare quotes");
    expect(out).not.toContain("unverified");
    expect(out).not.toContain("By when");
    expect(out).toContain("Whether the price includes tax");
    expect(out).not.toContain("Quokka ignore item");
  });

  it("zero items without a brief shows only the heading", () => {
    const out = render(view([]));
    expect(out).toContain("Nothing here needs your attention");
    expect(out).not.toContain("About this document");
  });
});

describe("formatDue (DESIGN_STANDARD Dates and numbers)", () => {
  const now = new Date("2026-10-05T15:00:00Z"); // Mon Oct 5, New York
  const f = (iso: string, timeKnown = false) => formatDue(iso, { timeKnown, timezone: "America/New_York", now });
  it("relative words, weekday, date, year and overdue", () => {
    expect(f("2026-10-06T03:59:00Z")).toBe("Due today");
    expect(f("2026-10-07T03:59:00Z")).toBe("Due tomorrow");
    expect(f("2026-10-10T03:59:00Z")).toBe("Due Fri");
    expect(f("2026-10-31T03:59:00Z")).toBe("Fri Oct 30");
    expect(f("2027-01-09T04:59:00Z")).toBe("Fri Jan 8, 2027");
    expect(f("2026-10-05T03:00:00Z")).toBe("1 day overdue");
    expect(f("2026-10-02T15:00:00Z")).toBe("3 days overdue");
  });
  it("shows a time only when the source gave one", () => {
    expect(f("2026-10-09T19:00:00Z", true)).toBe("Due Fri, 3:00 PM");
  });
});
