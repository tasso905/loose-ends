import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SIGN_IN_COPY as C } from "@/lib/auth/copy";

// SignInForm is a client component. Outside Next there is no app router, and the server action and
// browser Supabase client must not run, so those three boundaries are stubbed. Nothing is called
// during a static render; the stubs only make the imports resolvable.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/app/sign-in/actions", () => ({ sendMagicLink: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

const { SignInForm } = await import("@/components/auth/SignInForm");

const render = (googleEnabled: boolean) =>
  renderToStaticMarkup(createElement(SignInForm, { next: "/today", googleEnabled }));

/** An element whose entire text content is the divider word, e.g. `<p class="…">or</p>`. */
const dividerPattern = new RegExp(`>\\s*${C.orDivider}\\s*<`);

/** F1: "if Google is off, the divider and button are not rendered" (D41). */
describe("SignInForm Google button (F1, D41)", () => {
  it("copy under test is the approved wording", () => {
    expect(C.googleButton).toBe("Continue with Google");
    expect(C.orDivider).toBe("or");
    expect(C.sendButton).toBe("Email me a sign-in link");
  });

  it("googleEnabled=false renders the email form only: no divider, no Google button", () => {
    const html = render(false);
    expect(html).toContain(C.sendButton);
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).not.toContain(C.googleButton);
    expect(html).not.toMatch(dividerPattern);
  });

  it("googleEnabled=true renders the divider and the Google button after the send button", () => {
    const html = render(true);
    expect(html).toContain(C.sendButton);
    expect(html).toContain(C.googleButton);
    expect(html).toMatch(dividerPattern);
    // Order per SITE_CONTRACT §2.0: email form, then "or", then Google.
    const send = html.indexOf(C.sendButton);
    const divider = html.search(dividerPattern);
    const google = html.indexOf(C.googleButton);
    expect(send).toBeLessThan(divider);
    expect(divider).toBeLessThan(google);
  });
});
