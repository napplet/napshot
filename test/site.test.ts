import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createSite } from "../src/server.ts";

const signer = "a".repeat(64);
const status = {
  name: "Napshot",
  pubkey: signer,
  relays: [],
  blossomServers: [],
  counts: { pending: 3, done: 12, failed: 1 },
  lastScan: 1793370000,
};

async function fixture() {
  const server = createSite();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((done, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : done()));
      }),
  };
}

Deno.test("explainer works on desktop and mobile with keyboard, clipboard, and live status", async () => {
  const site = await fixture();
  const browser = await chromium.launch({
    executablePath: Deno.env.get('CHROMIUM_PATH') ?? "/usr/bin/chromium",
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text().includes("Content Security Policy")
      )
        errors.push(message.text());
    });
    await page.route("**/api/status", (route) =>
      route.fulfill({ json: status }),
    );
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (value: string) => {
            document.documentElement.dataset.copied = value;
            return Promise.resolve();
          },
        },
      });
    });
    await mkdir("/tmp/napshot-ui", { recursive: true });
    for (const [width, height, name] of [
      [1440, 1050, "desktop"],
      [360, 780, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(site.url);
      await page.waitForFunction(
        () =>
          document.querySelector("#service-state")?.textContent ===
          "Status endpoint reachable",
      );
      assert.equal(await page.locator("#signer-key").textContent(), signer);
      assert.equal(await page.locator("#pending-count").textContent(), "3");
      assert.equal(await page.locator("#done-count").textContent(), "12");
      assert.equal(await page.locator("#failed-count").textContent(), "1");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: `/tmp/napshot-ui/${name}.png`,
        fullPage: true,
      });
    }
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").textContent(), "Skip to content");
    await page.locator("#copy-command").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#copy-feedback")?.textContent ===
        "Command copied.",
    );
    assert.equal(
      await page.locator("html").getAttribute("data-copied"),
      "npx skills add napplet/napshot",
    );
    await page.getByRole("link", { name: /For shells/ }).click();
    assert.equal(new URL(page.url()).hash, "#shells");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await site.close();
  }
});

Deno.test("unavailable status and clipboard preserve readable instructions; API strings cannot inject markup", async () => {
  const site = await fixture();
  const browser = await chromium.launch({
    executablePath: Deno.env.get('CHROMIUM_PATH') ?? "/usr/bin/chromium",
  });
  try {
    const page = await browser.newPage();
    await page.route("**/api/status", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: () => {
            return Promise.reject(new Error("denied"));
          },
        },
      }),
    );
    await page.goto(site.url);
    await page.waitForFunction(
      () =>
        document.querySelector("#service-state")?.textContent ===
        "Live status unavailable",
    );
    assert.equal(await page.locator("#service-details").isVisible(), false);
    assert.equal(
      await page.locator("#install-command").textContent(),
      "npx skills add napplet/napshot",
    );
    await page.locator("#copy-command").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#copy-feedback")
        ?.textContent?.includes("manually"),
    );
    await page.unroute("**/api/status");
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          ...status,
          pubkey: '<img src=x onerror="window.injected=true">',
        },
      }),
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector("#service-state")?.textContent ===
        "No signer configured",
    );
    assert.equal(
      await page.locator("#signer-key").textContent(),
      "Not configured",
    );
    assert.equal(await page.locator("#signer-key img").count(), 0);
    await page.unroute("**/api/status");
    await page.route("**/api/status", (route) =>
      route.fulfill({ json: { ...status, counts: { pending: -1 } } }),
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector("#service-state")?.textContent ===
        "Live status unavailable",
    );
    assert.equal(await page.locator("#service-details").isVisible(), false);
  } finally {
    await browser.close();
    await site.close();
  }
});

Deno.test("actual server serves the SPA, public assets, and exact skill with security headers", async () => {
  const site = await fixture();
  try {
    for (const [path, filename, contentType] of [
      ["/", "public/index.html", "text/html"],
      ["/style.css", "public/style.css", "text/css"],
      ["/app.js", "public/app.js", "text/javascript"],
      ["/skill", "skills/napshot-shell/SKILL.md", "text/plain"],
    ]) {
      const response = await fetch(site.url + path);
      assert.equal(response.status, 200, path);
      assert.ok(
        response.headers.get("content-type")?.startsWith(contentType),
        path,
      );
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.ok(
        response.headers
          .get("content-security-policy")
          ?.includes("script-src 'self'"),
      );
      assert.equal(
        await response.text(),
        await readFile(resolve(filename), "utf8"),
      );
    }
    const response = await fetch(site.url + "/api/status");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      name: "Napshot",
      pubkey: null,
      relays: [],
      blossomServers: [],
      counts: { pending: 0, done: 0, failed: 0 },
      lastScan: null,
      relayErrors: {},
    });
    for (const [path, method, expectedStatus] of [
      ["/healthz", "GET", 503], ["/.env", "GET", 404], ["/api/status", "POST", 405],
    ] as const) {
      const response = await fetch(site.url + path, { method });
      assert.equal(response.status, expectedStatus);
      await response.body?.cancel();
    }
  } finally {
    await site.close();
  }
});
