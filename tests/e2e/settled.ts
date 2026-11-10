import { expect, type Page } from "@playwright/test";

/**
 * Lead-tester: wait until the page has stopped moving before axe looks at it, so a half-faded element
 * (the Undo toast fading in, a sheet opening) is never measured mid-transition and reported as low
 * contrast. No fixed sleeps:
 *
 * 1. In the page, wait for every finite animation and CSS transition to finish, and require three
 *    quiet animation frames in a row. A transition that starts on the next frame (the toast sets its
 *    "shown" class in requestAnimationFrame) is therefore caught too. Infinite ones (spinners) are
 *    skipped.
 * 2. Then poll the final computed opacity: every open dialog and every Undo toast (with its
 *    ancestors) must be fully opaque. The Undo button's own opacity is not counted, because a busy
 *    button is legitimately 50% (disabled).
 */
export async function settled(page: Page, timeout = 10_000) {
  await page.evaluate(async (ms) => {
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const deadline = performance.now() + ms;
    let quiet = 0;
    while (quiet < 3) {
      if (performance.now() > deadline) throw new Error(`animations still running after ${ms} ms`);
      await frame();
      const moving = document
        .getAnimations()
        .filter((a) => a.playState !== "finished" && a.playState !== "idle" && a.effect?.getComputedTiming().endTime !== Infinity);
      if (moving.length === 0) quiet++;
      else {
        quiet = 0;
        await Promise.all(moving.map((a) => a.finished.catch(() => undefined)));
      }
    }
  }, timeout);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const opacity = (el: Element | null) => {
            let o = 1;
            for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
            return o;
          };
          const targets = [
            ...[...document.querySelectorAll('button[aria-label^="Undo "]')].map((b) => b.parentElement),
            ...document.querySelectorAll("dialog[open]"),
          ];
          return targets.filter((t) => t && opacity(t) < 1).map((t) => `${t!.tagName.toLowerCase()} ${opacity(t).toFixed(2)}`);
        }),
      { timeout, message: "toasts and open dialogs reach full opacity before axe runs" },
    )
    .toEqual([]);
}
