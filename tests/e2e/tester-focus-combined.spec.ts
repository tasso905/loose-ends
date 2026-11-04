import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type CDPSession, type Page, type Route } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester, fix/focus-combined (fix/s8-escape 88c34ab + afedf30): attacks on the merged head beyond
 * the developers' specs. Close paths and their races, Done + Undo orderings, where a failed save puts
 * focus, reason focus when the user moved on, the refresh is lost or the save fails; 6x CPU; axe at both
 * widths. Local Supabase + recorded LLM fixtures. Synthetic text only.
 * `test.fail` pins a defect: it asserts the SAFE behaviour and currently fails.
 */

test.describe.configure({ mode: "serial" });

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const DEC = "e2e5b9b0-0000-4000-8000-000000000001"; // the id the recorded Ask-why answer cites
const ASK = "Why did I pick the pool gym?";
const LABEL = "Want me to remember why?";
const SAVE_FAILED = "That didn't save. Try again.";
const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
let threadId = "";
let threadUrl = "";

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const reopen = async (id = threadId) => {
  await admin().from("decisions").delete().eq("thread_id", id);
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null, kind: "commitment" }).eq("id", id);
};
const sheet = () => page.getByRole("dialog", { name: "How did this end?" });
const resolveBtn = () => page.getByRole("button", { name: "Resolve…" });
const doneBtn = () => page.getByRole("button", { name: "Done", exact: true });
const statusLine = () => page.locator("#thread-status");
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
/** "body", or a description of the focused element. */
const focusAt = () =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "body";
    const where = a.closest("dialog") ? "in-sheet:" : "";
    return `${where}${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}:${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 40)}`;
  });

async function axe(p: Page) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function holdActions(fail: boolean) {
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/*", async (route) => {
    if (!isServerAction(route.request().method(), route.request().headers())) return route.continue();
    held = true;
    await gate;
    if (fail) return route.abort("failed");
    return route.continue();
  });
  return { release, isHeld: () => held };
}
async function failActions() {
  await page.route("**/*", (route) =>
    isServerAction(route.request().method(), route.request().headers()) ? route.abort("failed") : route.continue(),
  );
}
async function throttle(rate: number): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  return cdp;
}
async function unthrottle(cdp: CDPSession) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();
}
/** A resolved decision thread whose decision has no reason. */
async function seedDecision(title: string, id?: string) {
  const db = admin();
  if (id) await db.from("decisions").delete().eq("id", id);
  const t = await db.from("threads").insert({ user_id: uid, title, kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).select("id").single();
  expect(t.error).toBeNull();
  const d = await db
    .from("decisions")
    .insert({ ...(id ? { id } : {}), user_id: uid, thread_id: t.data!.id, choice: id ? "Joined the pool gym" : "Took the river route", reason_user: null, context_facts: [], decided_at: "2026-10-18T14:05:00Z" })
    .select("id")
    .single();
  expect(d.error).toBeNull();
  return { threadId: t.data!.id as string, decisionId: d.data!.id as string };
}
async function openDecided() {
  await reopen();
  await page.goto(threadUrl);
  await resolveBtn().click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Synthetic decision K3");
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  threadId = (await admin().from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
  threadUrl = `/threads/${threadId}`;
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

// ---- Resolve sheet: close paths -----------------------------------------------------------------

for (const how of ["Escape", "Cancel click", "Cancel keyboard", "scrim"] as const) {
  test(`idle close by ${how}: focus returns to Resolve…, and the sheet reopens fresh`, async () => {
    await reopen();
    await page.goto(threadUrl);
    await resolveBtn().click();
    await sheet().getByRole("radio", { name: "Decided" }).check();
    await sheet().getByLabel("What did you decide?").fill("Typed, then abandoned");
    if (how === "Escape") await page.keyboard.press("Escape");
    else if (how === "Cancel click") await sheet().getByRole("button", { name: "Cancel" }).click();
    else if (how === "Cancel keyboard") {
      await sheet().getByRole("button", { name: "Cancel" }).focus();
      await page.keyboard.press("Enter");
    } else await page.mouse.click(5, 5);
    await expect(sheet()).toBeHidden();
    await expect(resolveBtn()).toBeFocused();
    await resolveBtn().click();
    await expect(sheet().getByRole("radio", { name: "Done" })).toBeChecked();
    await expect(sheet().getByLabel("What did you decide?")).toHaveCount(0);
    await expect(sheet().getByRole("radio", { name: "Done" })).toBeFocused();
  });
}

test("?sheet=resolve: Escape closes it and focus lands on Resolve…", async () => {
  await reopen();
  await page.goto(`${threadUrl}?sheet=resolve`);
  await expect(sheet()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet()).toBeHidden();
  await expect(resolveBtn()).toBeFocused();
});

test("Today row: Escape and Cancel return focus to that row's Resolve…", async () => {
  await reopen();
  await page.goto("/today");
  const rowResolve = page.getByRole("button", { name: `Resolve… ${TITLE}` });
  for (const how of ["Escape", "Cancel"]) {
    await rowResolve.click();
    await expect(sheet()).toBeVisible();
    if (how === "Escape") await page.keyboard.press("Escape");
    else await sheet().getByRole("button", { name: "Cancel" }).click();
    await expect(sheet()).toBeHidden();
    await expect(rowResolve, how).toBeFocused();
  }
});

// The race the developers' specs wait out: they assert closedby="none" before pressing Escape.
for (const fail of [false, true]) {
  test(`Escape in the same breath as Save, CPU 6x (save ${fail ? "fails" : "succeeds"}): the sheet stays open until the server answers`, async () => {
    await openDecided();
    const h = await holdActions(fail);
    const cdp = await throttle(6);
    try {
      await sheet().getByRole("button", { name: "Save" }).click({ noWaitAfter: true });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect.poll(h.isHeld, { timeout: 10_000 }).toBe(true);
      await page.waitForTimeout(500);
      await expect(sheet()).toBeVisible();
      await expect(statusLine()).toHaveText("Open");
      h.release();
      if (fail) {
        await expect(sheet().getByText(SAVE_FAILED)).toBeVisible({ timeout: 15_000 });
        await expect(sheet().getByLabel("What did you decide?")).toHaveValue("Synthetic decision K3");
        await expect.poll(focusAt, { timeout: 5_000 }).toMatch(/^in-sheet:div:.*didn't save/);
      } else {
        await expect(sheet()).toBeHidden({ timeout: 15_000 });
        await expect(statusLine()).toHaveText("Resolved", { timeout: 15_000 });
        await expect.poll(focusAt, { timeout: 5_000 }).toMatch(/#thread-status/);
      }
    } finally {
      await unthrottle(cdp);
    }
  });
}

for (const how of ["Tab then Enter on disabled Cancel", "Skip then Escape", "reload-free native close"] as const) {
  test(`while pending, ${how}: nothing closes and nothing claims success`, async () => {
    await openDecided();
    const h = await holdActions(false);
    if (how === "Skip then Escape") {
      await sheet().getByRole("button", { name: "Skip" }).click();
      await expect.poll(h.isHeld).toBe(true);
      await page.keyboard.press("Escape");
    } else {
      await sheet().getByRole("button", { name: "Save" }).click();
      await expect.poll(h.isHeld).toBe(true);
      if (how === "reload-free native close") {
        await page.evaluate(() => [...document.querySelectorAll("dialog")].find((d) => d.open)?.close());
      } else {
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
      }
    }
    await page.waitForTimeout(400);
    await expect(sheet()).toBeVisible();
    await expect(statusLine()).toHaveText("Open");
    await expect(page.getByRole("button", { name: /^Undo resolve:/ })).toHaveCount(0);
    h.release();
    await expect(sheet()).toBeHidden({ timeout: 10_000 });
    await expect(statusLine()).toHaveText("Resolved");
  });
}

// ---- Resolve sheet: where a failure puts focus --------------------------------------------------

for (const how of ["Save click", "Enter in the field", "Skip"] as const) {
  test(`a save that fails (${how}): focus is on the error inside the sheet`, async () => {
    await openDecided();
    await failActions();
    if (how === "Save click") await sheet().getByRole("button", { name: "Save" }).click();
    else if (how === "Skip") await sheet().getByRole("button", { name: "Skip" }).click();
    else await sheet().getByLabel("What did you decide?").press("Enter");
    await expect(sheet().getByText(SAVE_FAILED)).toBeVisible();
    await expect.poll(focusAt).toMatch(/^in-sheet:div:.*didn't save/);
  });
}

test("a second failure moves focus to the error again; Escape then returns focus to Resolve…", async () => {
  await openDecided();
  await failActions();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByText(SAVE_FAILED)).toBeVisible();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByRole("button", { name: "Save" })).toBeEnabled();
  await expect.poll(focusAt).toMatch(/^in-sheet:div:.*didn't save/);
  await page.keyboard.press("Escape");
  await expect(sheet()).toBeHidden();
  await expect(resolveBtn()).toBeFocused();
});

test("after a failed save, a scrim click closes the sheet and focus returns to Resolve…", async () => {
  await openDecided();
  await failActions();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByText(SAVE_FAILED)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(sheet()).toBeHidden();
  await expect(resolveBtn()).toBeFocused();
});

test("a server refusal (the thread changed elsewhere): focus is on the error, which offers Refresh", async () => {
  await openDecided();
  await admin().from("threads").update({ status: "resolved", resolution: "not_needed", resolved_at: new Date().toISOString() }).eq("id", threadId);
  await sheet().getByRole("button", { name: "Save" }).click();
  const refresh = sheet().getByRole("button", { name: "Refresh" });
  await expect(refresh).toBeVisible();
  await expect.poll(focusAt).toMatch(/^in-sheet:div:/);
  await reopen();
});

test("field errors focus their field: blank decision; over-long decision and reason are held at the limit", async () => {
  await openDecided();
  const choice = sheet().getByLabel("What did you decide?");
  const reason = sheet().getByLabel(LABEL);
  await choice.fill("   ");
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(choice).toHaveAttribute("aria-invalid", "true");
  await expect(choice).toBeFocused();
  // S11's clampChars replaced maxLength on these fields, so the UI can no longer send an over-long value:
  // removing the attribute no longer reaches the server's refusal. The field holds the limit instead; the
  // server's refusal and its copy stay covered at the action level.
  await choice.fill("x".repeat(5000));
  await expect(choice).toHaveValue("x".repeat(300));
  await choice.fill("Synthetic decision K3");
  await reason.fill("y".repeat(5000));
  await expect(reason).toHaveValue("y".repeat(2000));
  await expect(sheet()).toBeVisible();
  await expect(statusLine()).toHaveText("Open");
});

// ---- Done, then Undo ----------------------------------------------------------------------------

for (const rate of [1, 6]) {
  test(`Done, immediate Undo by mouse (CPU ${rate}x, 3 runs): focus ends on Done and stays`, async () => {
    const cdp = await throttle(rate);
    try {
      for (let i = 0; i < 3; i++) {
        await reopen();
        await page.goto(threadUrl);
        await doneBtn().click();
        await page.getByRole("button", { name: /^Undo done:/ }).click({ timeout: 15_000 });
        await expect(statusLine()).toHaveText("Open", { timeout: 15_000 });
        await expect(doneBtn(), `run ${i + 1}`).toBeFocused({ timeout: 10_000 });
        await page.waitForTimeout(800);
        await expect(doneBtn(), `run ${i + 1} stays`).toBeFocused();
      }
    } finally {
      await unthrottle(cdp);
    }
  });
}

test("Done, immediate Undo by keyboard: focus ends on Done", async () => {
  await reopen();
  await page.goto(threadUrl);
  await doneBtn().focus();
  await page.keyboard.press("Enter");
  const undo = page.getByRole("button", { name: /^Undo done:/ });
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(statusLine()).toHaveText("Open");
  await expect(doneBtn()).toBeFocused({ timeout: 10_000 });
});

test("Done's refresh held back past the Undo: focus still ends on Done, never <body>", async () => {
  await reopen();
  await page.goto(threadUrl);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**/threads/${threadId}*`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET" && "rsc" in req.headers()) await gate;
    return route.continue();
  });
  await doneBtn().click();
  await page.getByRole("button", { name: /^Undo done:/ }).click();
  await expect(page.getByRole("button", { name: /^Undo done:/ })).toHaveCount(0, { timeout: 10_000 });
  expect(await focusAt()).not.toBe("body");
  release();
  await expect(doneBtn()).toBeEnabled({ timeout: 10_000 });
  await expect(doneBtn()).toBeFocused({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await expect(doneBtn()).toBeFocused();
});

test("Undo after Done's refresh has landed (Done left the page): focus returns to Done", async () => {
  await reopen();
  await page.goto(threadUrl);
  await doneBtn().click();
  await expect(statusLine()).toHaveText("Resolved");
  await expect(doneBtn()).toHaveCount(0);
  await page.getByRole("button", { name: /^Undo done:/ }).click();
  await expect(doneBtn()).toBeFocused({ timeout: 10_000 });
});

test("a decision thread: Undo returns focus to Resolve…", async () => {
  await reopen();
  await admin().from("threads").update({ kind: "decision" }).eq("id", threadId);
  await page.goto(threadUrl);
  await resolveBtn().click();
  await sheet().getByLabel("What did you decide?").fill("Synthetic decision K4");
  await sheet().getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: /^Undo resolve:/ }).click();
  await expect(resolveBtn()).toBeFocused({ timeout: 10_000 });
  await reopen();
});

test("Undo that fails at the network: focus is on the error banner, never <body>", async () => {
  await reopen();
  await page.goto(threadUrl);
  await doneBtn().click();
  await expect(statusLine()).toHaveText("Resolved");
  await failActions();
  await page.getByRole("button", { name: /^Undo done:/ }).click();
  await expect(page.getByText(SAVE_FAILED)).toBeVisible();
  await expect.poll(focusAt).toMatch(/^div:.*didn't save/);
});

test("Today: Done, immediate Undo: focus is never <body>; the row is back", async () => {
  await reopen();
  await page.goto("/today");
  await page.getByRole("button", { name: `Done: ${TITLE}`, exact: true }).click();
  await page.getByRole("button", { name: /^Undo done:/ }).click();
  await expect(page.getByRole("button", { name: `Done: ${TITLE}`, exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  expect(await focusAt()).not.toBe("body");
});

test("Today: Done, Undo after the row left: focus is never <body>; the row is back", async () => {
  await reopen();
  await page.goto("/today");
  await page.getByRole("button", { name: `Done: ${TITLE}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Done: ${TITLE}`, exact: true })).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("button", { name: /^Undo done:/ }).click();
  await expect(page.getByRole("button", { name: `Done: ${TITLE}`, exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  expect(await focusAt()).not.toBe("body");
});

// ---- Adding a reason ----------------------------------------------------------------------------

async function askCard() {
  await page.goto("/decisions");
  await page.getByRole("textbox", { name: "Ask about a past decision" }).fill(ASK);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const card = page.getByRole("article");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  return card;
}

test("Thread detail, CPU 6x, refresh held: focus on the reason as it mounts and after the refresh (3 runs)", async () => {
  const cdp = await throttle(6);
  try {
    for (let i = 0; i < 3; i++) {
      const { threadId: t, decisionId } = await seedDecision(`Choose a route ${i}`);
      await page.goto(`/threads/${t}`);
      await page.getByRole("button", { name: "Add a reason now" }).click();
      await page.getByLabel(LABEL).fill("Closer to work.");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await page.route(`**/threads/${t}*`, async (route: Route) => {
        const req = route.request();
        if (req.method() === "GET" && "rsc" in req.headers()) await gate;
        return route.continue();
      });
      await page.getByRole("button", { name: "Save" }).click();
      const reason = page.locator(`#reason-${decisionId}`);
      await expect(reason, `run ${i + 1}`).toBeFocused({ timeout: 15_000 });
      release();
      await expect(page.getByText("You added a reason for your decision.")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await expect(reason, `run ${i + 1} after refresh`).toBeFocused();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  } finally {
    await unthrottle(cdp);
  }
});

test("Ask why, CPU 6x: focus on the reason as it mounts (3 runs)", async () => {
  for (let i = 0; i < 3; i++) {
    await seedDecision("Choose a gym", DEC);
    const card = await askCard();
    await card.getByRole("button", { name: "Add a reason now" }).click();
    await card.getByLabel(LABEL).fill("Open early and on my way.");
    const cdp = await throttle(6);
    try {
      await card.getByRole("button", { name: "Save" }).click();
      await expect(page.locator(`#reason-${DEC}`), `run ${i + 1}`).toBeFocused({ timeout: 15_000 });
      await page.waitForTimeout(500);
      await expect(page.locator(`#reason-${DEC}`), `run ${i + 1} stays`).toBeFocused();
    } finally {
      await unthrottle(cdp);
    }
  }
});

test("the user moved on before the refresh landed: the refresh does not pull focus back to the reason", async () => {
  const { threadId: t, decisionId } = await seedDecision("Choose a route, moved on");
  await page.goto(`/threads/${t}`);
  await page.getByRole("button", { name: "Add a reason now" }).click();
  await page.getByLabel(LABEL).fill("Closer to work.");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**/threads/${t}*`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET" && "rsc" in req.headers()) await gate;
    return route.continue();
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(`#reason-${decisionId}`)).toBeFocused();
  await page.keyboard.press("Tab");
  const moved = await focusAt();
  expect(moved).not.toBe("body");
  expect(moved).not.toContain(`reason-${decisionId}`);
  release();
  await expect(page.getByText("You added a reason for your decision.")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await expect(page.locator(`#reason-${decisionId}`)).not.toBeFocused();
});

// A failed RSC refresh makes Next fall back to a full document load. Focus then starts at the top of the
// new page, as on any load, so this pins what survives: the reason, shown from the server.
test("the refresh fails at the network: Next reloads the document and the reason is still shown", async () => {
  const { threadId: t, decisionId } = await seedDecision("Choose a route, refresh lost");
  await page.goto(`/threads/${t}`);
  await page.getByRole("button", { name: "Add a reason now" }).click();
  await page.getByLabel(LABEL).fill("Closer to work.");
  await page.route(`**/threads/${t}*`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET" && "rsc" in req.headers()) return route.abort("failed");
    return route.continue();
  });
  const reloaded = page.waitForRequest((r) => r.isNavigationRequest() && r.url().includes(`/threads/${t}`), { timeout: 10_000 });
  await page.getByRole("button", { name: "Save" }).click();
  await reloaded;
  await page.waitForLoadState("load");
  await expect(page.locator(`#reason-${decisionId}`)).toBeVisible();
  await expect(page.locator(`#reason-${decisionId}`)).toContainText("Closer to work.");
});

for (const surface of ["Thread detail", "Ask why"] as const) {
  // OPEN DEFECT (T-F1, a11y WCAG 2.4.3, low-medium; pre-existing): NoReason's `catch` sets the error but moves
  // no focus, unlike its `!res.ok` branch and the Resolve sheet. Save is disabled while pending, so focus
  // falls to <body> and stays there; the keyboard user restarts from the top of the page.
  test(`${surface}: a reason save that fails at the network leaves focus in the form, on the field, not <body>`, async () => {
    test.fail(true, "T-F1: NoReason's catch branch does not move focus");
    const { threadId: t } = surface === "Ask why" ? await seedDecision("Choose a gym", DEC) : await seedDecision("Choose a route, save fails");
    const scope = surface === "Ask why" ? await askCard() : page.locator("main");
    if (surface === "Thread detail") await page.goto(`/threads/${t}`);
    await scope.getByRole("button", { name: "Add a reason now" }).click();
    const field = scope.getByLabel(LABEL);
    await field.fill("Closer to work.");
    await failActions();
    await scope.getByRole("button", { name: "Save" }).click();
    await expect(scope.getByText(SAVE_FAILED)).toBeVisible();
    await expect(scope.getByRole("button", { name: "Save" })).toBeEnabled();
    await page.waitForTimeout(200);
    const where = await focusAt();
    console.log(`T-F1 ${surface}: focus after a failed reason save = ${where}`);
    expect(where).not.toBe("body");
    await expect(field).toBeFocused({ timeout: 1_000 });
  });

  test(`${surface}: blank and over-long reasons focus the field; Cancel returns to Add a reason now`, async () => {
    const { threadId: t } = surface === "Ask why" ? await seedDecision("Choose a gym", DEC) : await seedDecision("Choose a route, bad input");
    const scope = surface === "Ask why" ? await askCard() : page.locator("main");
    if (surface === "Thread detail") await page.goto(`/threads/${t}`);
    const add = scope.getByRole("button", { name: "Add a reason now" });
    await add.click();
    const field = scope.getByLabel(LABEL);
    await expect(field).toBeFocused();
    await field.fill("  \n ");
    await scope.getByRole("button", { name: "Save" }).click();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toBeFocused();
    await scope.getByRole("button", { name: "Cancel" }).click();
    await expect(add).toBeFocused();
  });
}

// ---- axe at both widths --------------------------------------------------------------------------

for (const width of [1280, 375]) {
  test(`axe at ${width} px: Resolve sheet (idle, Decided, field error, save error), Thread detail and Ask why add-reason states, toast`, async () => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
    await openDecided();
    await axe(page);
    await sheet().getByLabel("What did you decide?").fill("  ");
    await sheet().getByRole("button", { name: "Save" }).click();
    await expect(sheet().getByLabel("What did you decide?")).toHaveAttribute("aria-invalid", "true");
    await axe(page);
    await sheet().getByLabel("What did you decide?").fill("Synthetic decision K3");
    await failActions();
    await sheet().getByRole("button", { name: "Save" }).click();
    await expect(sheet().getByText(SAVE_FAILED)).toBeVisible();
    await axe(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    await reopen();
    await page.goto(threadUrl);
    await doneBtn().click();
    await expect(page.getByRole("button", { name: /^Undo done:/ })).toBeVisible();
    await axe(page);

    const { threadId: t, decisionId } = await seedDecision(`Choose a route ${width}`);
    await page.goto(`/threads/${t}`);
    await axe(page);
    await page.getByRole("button", { name: "Add a reason now" }).click();
    await axe(page);
    await page.getByLabel(LABEL).fill("  ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByLabel(LABEL)).toHaveAttribute("aria-invalid", "true");
    await axe(page);
    await page.getByLabel(LABEL).fill("Closer to work.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(`#reason-${decisionId}`)).toBeFocused();
    await expect(page.getByText("You added a reason for your decision.")).toBeVisible();
    await axe(page);

    await seedDecision("Choose a gym", DEC);
    const card = await askCard();
    await axe(page);
    await card.getByRole("button", { name: "Add a reason now" }).click();
    await axe(page);
    await card.getByLabel(LABEL).fill("Open early.");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(`#reason-${DEC}`)).toBeFocused();
    await axe(page);
    if (width === 375) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
