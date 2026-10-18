import { describe, expect, it } from "vitest";
import { bandForScore, confidenceLabel, scoreItem, type ScoreInput } from "@/lib/pipeline/score";

const base: ScoreInput = {
  type: "commitment",
  owner: "user",
  certainty: "explicit",
  matchKinds: ["exact"],
  quotes: ["I'll send you the revised proposal Friday"],
  dateAgreement: "agree",
};

describe("scoreItem(): PRD Confidence & Uncertainty Model weights", () => {
  it("the proposal example is High / Likely: 'Clear commitment with a date.' (F19)", () => {
    const r = scoreItem(base);
    expect(r.score).toBe(0.95); // 0.80 + 0.05 exact + 0.05 date + 0.05 modal
    expect(r.band).toBe("high");
    expect(confidenceLabel("commitment", r.band!, r.signals)).toEqual({ word: "Likely", reason: "Clear commitment with a date." });
  });

  it("base values per certainty", () => {
    const plain = { ...base, matchKinds: ["fuzzy" as const], quotes: ["send it"], dateAgreement: "chrono_only" as const };
    expect(scoreItem({ ...plain, certainty: "explicit" }).score).toBe(0.8);
    expect(scoreItem({ ...plain, certainty: "implied" }).score).toBe(0.55);
    expect(scoreItem({ ...plain, certainty: "speculative" }).score).toBe(0.3);
  });

  it("owner unknown on commitment/request costs 0.25; not on other types", () => {
    expect(scoreItem({ ...base, owner: "unknown" }).score).toBe(0.7);
    expect(scoreItem({ ...base, type: "request", owner: "unknown", quotes: ["Can you send it Friday?"] }).score).toBe(0.65);
    expect(scoreItem({ ...base, type: "deadline", owner: "unknown", quotes: ["Renews Oct 31"] }).score).toBe(0.9);
  });

  it("date disagreement costs 0.15 (also when the model dated a phrase chrono can't read)", () => {
    expect(scoreItem({ ...base, dateAgreement: "disagree" }).score).toBe(0.75);
    expect(scoreItem({ ...base, dateAgreement: "model_only" }).score).toBe(0.75);
  });

  it("first-person modal bonus applies only to commitments, and reads curly apostrophes", () => {
    expect(scoreItem({ ...base, quotes: ["I’ll send it"] }).signals).toContain("first_person_modal");
    expect(scoreItem({ ...base, quotes: ["I am going to send it"] }).signals).toContain("first_person_modal");
    expect(scoreItem({ ...base, type: "request", quotes: ["I'll need it Friday"] }).signals).not.toContain("first_person_modal");
  });

  it.each(["maybe", "probably", "sometime", "might"])("hedge word '%s' costs 0.15", (w) => {
    const r = scoreItem({ ...base, quotes: [`I'll ${w} send it`] });
    expect(r.signals).toContain("hedge_words");
    expect(r.score).toBe(0.8);
  });

  it("type disabled by the user is dropped (F17)", () => {
    expect(scoreItem({ ...base, disabledTypes: ["commitment"] })).toEqual({ score: null, band: null, signals: [] });
  });

  it("score is clamped to 0..1", () => {
    const r = scoreItem({ ...base, certainty: "speculative", owner: "unknown", dateAgreement: "disagree", matchKinds: ["fuzzy"], quotes: ["maybe"] });
    expect(r.score).toBe(0);
    expect(r.band).toBe("ignore");
  });
});

describe("bands", () => {
  it("edges: High ≥ 0.75, Medium 0.50–0.74, Low 0.30–0.49, Ignore < 0.30", () => {
    expect(bandForScore(0.75)).toBe("high");
    expect(bandForScore(0.74)).toBe("medium");
    expect(bandForScore(0.5)).toBe("medium");
    expect(bandForScore(0.49)).toBe("low");
    expect(bandForScore(0.3)).toBe("low");
    expect(bandForScore(0.29)).toBe("ignore");
  });

  it("labels: Likely / Maybe / Also noticed; Ignore has no label (D3)", () => {
    expect(confidenceLabel("commitment", "medium", ["hedge_words"])?.word).toBe("Maybe");
    expect(confidenceLabel("commitment", "low", [])?.word).toBe("Also noticed");
    expect(confidenceLabel("commitment", "ignore", [])).toBeNull();
  });

  it("reasons name why it is uncertain", () => {
    expect(confidenceLabel("commitment", "medium", ["hedge_words"])?.reason).toBe(
      "Possible intention detected, but I'm not confident enough to remind you.",
    );
    expect(confidenceLabel("commitment", "medium", ["owner_unknown"])?.reason).toBe("I'm not sure who said this.");
    expect(confidenceLabel("commitment", "medium", ["date_disagrees"])?.reason).toBe("I'm not sure about the date.");
    expect(confidenceLabel("request", "low", ["no_date"])?.reason).toBe("Possible request, but no date was mentioned.");
  });
});

describe("PRD lunch example (PRD Question #11, option b; user decision Oct 18)", () => {
  it("'We should grab lunch sometime', speculative intention: 0.30 + 0.05 exact = 0.35 → Low / Also noticed", () => {
    const r = scoreItem({
      type: "intention",
      owner: "user",
      certainty: "speculative",
      matchKinds: ["exact"],
      quotes: ["We should grab lunch sometime"],
      dateAgreement: "none",
    });
    expect(r.score).toBe(0.35);
    expect(r.band).toBe("low");
    expect(confidenceLabel("intention", r.band!, r.signals)).toEqual({
      word: "Also noticed",
      reason: "Possible intention detected, but I'm not confident enough to remind you.",
    });
  });

  it("hedge words still cost 0.15 on every other type", () => {
    expect(scoreItem({ ...base, type: "request", quotes: ["Maybe send it Friday?"] }).score).toBe(0.75);
  });
});
