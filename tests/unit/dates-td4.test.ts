import { describe, expect, it } from "vitest";
import { resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";

/**
 * T-D4 (eval gate, fixture 13 g1): a clock time inside the DST spring-forward gap. The model's
 * date_iso "2027-03-14T02:30:00" (no offset) is normalised to 03:30 EDT, while chrono's reading of
 * "Sunday at 2:30am" kept the raw wall time 02:30, so the two never agreed: a false `inferred` and
 * a "Check this date" line (High → Medium). Both name the same instant once chrono's wall time is
 * normalised the same way, so they must agree.
 */

const NY: DateContext = { referenceDate: "2027-03-11", referenceDateSource: "user", timezone: "America/New_York" };
const r = (iso: string | null) => resolveDate({ date_text: "Sunday at 2:30am", date_iso: iso }, NY);

describe("T-D4: a time inside the spring-forward gap", () => {
  // OPEN DEFECT T-D4: it.fails until resolveDates compares instants.
  it.fails.each(["2027-03-14T02:30:00", "2027-03-14T03:30:00", "2027-03-14T07:30:00Z", "2027-03-14T02:30:00-05:00"])(
    "model %s agrees with chrono's 'Sunday at 2:30am' (3:30 AM EDT)",
    (iso) => {
      const d = r(iso);
      expect({ agreement: d.agreement, certainty: d.due_certainty, due_at: d.due_at, not_sure: d.not_sure }).toEqual({
        agreement: "agree",
        certainty: "explicit",
        due_at: "2027-03-14T07:30:00.000Z",
        not_sure: [],
      });
    },
  );

  it("a date-only date_iso still agrees", () => {
    expect(r("2027-03-14").agreement).toBe("agree");
  });

  // Guards: a genuinely different instant still disagrees (and chrono's value is kept).
  it("-04:00 (06:30Z = 1:30 AM EST) is a different instant: disagree, chrono kept", () => {
    const d = r("2027-03-14T02:30:00-04:00");
    expect(d.agreement).toBe("disagree");
    expect(d.due_at).toBe("2027-03-14T07:30:00.000Z");
    expect(d.due_certainty).toBe("inferred");
  });

  it("a different hour on the same day disagrees", () => {
    expect(r("2027-03-14T04:30:00").agreement).toBe("disagree");
  });
});
