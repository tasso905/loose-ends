import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_SETTINGS_COPY, SIGN_IN_COPY } from "@/lib/auth/copy";

// Pretend S2 has flipped the gate, to check where the notice would render. The server action is
// stubbed; nothing is called during a static render.
const gate = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/supabase/env", () => ({ isAnalyticsEnabled: () => gate.on }));
vi.mock("@/app/settings/actions", () => ({ setAnalyticsEnabled: vi.fn() }));

const { AuthNotices } = await import("@/components/auth/Notices");
const { AnalyticsToggle } = await import("@/components/settings/AnalyticsToggle");

describe("analytics notice placement (SITE_CONTRACT §2.0, D40)", () => {
  it("copy is the approved wording (Oct 21)", () => {
    expect(SIGN_IN_COPY.analyticsNotice).toBe("Loose Ends counts which features you use. Analytics never include what you paste.");
    expect(SIGN_IN_COPY.analyticsOptOut).toBe("Turn off analytics");
  });

  it("onboarding shows the notice and the opt-out link to Settings → Profile once the gate is on", () => {
    gate.on = true;
    const html = renderToStaticMarkup(createElement(AuthNotices, { analytics: true }));
    expect(html).toContain(SIGN_IN_COPY.analyticsNotice);
    expect(html).toMatch(/href="\/settings#profile"[^>]*>Turn off analytics</);
  });

  it("sign-in (no analytics prop) never shows it", () => {
    gate.on = true;
    expect(renderToStaticMarkup(createElement(AuthNotices))).not.toMatch(/analytics/i);
  });

  it("stays hidden in onboarding while the gate is off (S1)", () => {
    gate.on = false;
    const html = renderToStaticMarkup(createElement(AuthNotices, { analytics: true }));
    expect(html).toContain("full account numbers.");
    expect(html).not.toMatch(/analytics/i);
  });
});

describe("Settings analytics toggle (DESIGN_STANDARD Toggle)", () => {
  it.each([true, false])("renders a labelled switch with aria-checked=%s and the description", (on) => {
    const html = renderToStaticMarkup(createElement(AnalyticsToggle, { initialEnabled: on }));
    expect(html).toMatch(new RegExp(`role="switch" aria-checked="${on}"`));
    expect(html).toContain(ANALYTICS_SETTINGS_COPY.toggleLabel);
    expect(html).toContain(ANALYTICS_SETTINGS_COPY.toggleDescription);
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });
});
