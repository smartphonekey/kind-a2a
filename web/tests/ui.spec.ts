// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from "@playwright/test";

const token = "browser_fixture_access_token_not_for_real_use";
async function login(page: Page) {
  await page.goto("/ui/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
async function openTasks(page: Page) {
  const button = page.getByRole("button", { name: "Open task list" });
  if (await button.isVisible()) await button.click();
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".composer")
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
  ).toBe(true);
  expect(
    await page
      .locator("img")
      .evaluateAll((images) =>
        images.every((img) => (img as HTMLImageElement).naturalWidth > 0),
      ),
  ).toBe(true);
}

test("lost send acknowledgement is never retried automatically", async ({
  page,
  request,
}) => {
  await login(page);
  let sentMessageId = "";
  let sends = 0;
  await page.route("**/web-api/agents/codex/message:stream", async (route) => {
    sends++;
    const body = route.request().postDataJSON();
    sentMessageId = body.message.messageId;
    const accepted = await page.request.post(
      "/web-api/agents/codex/message:send",
      {
        headers: { Origin: "http://127.0.0.1:8094", "A2A-Version": "1.0" },
        data: { ...body, configuration: { returnImmediately: true } },
      },
    );
    expect(accepted.ok()).toBe(true);
    await route.abort("failed");
  });
  await send(page, "Delivery receipt test");
  await expect(page.getByRole("alert")).toContainText("No message was retried");
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect
    .poll(
      async () =>
        (await (await request.get("/__fixture/calls")).json()).filter(
          (c: { messageId: string }) => c.messageId === sentMessageId,
        ).length,
    )
    .toBe(1);
  await page.waitForTimeout(2300);
  expect(sends).toBe(1);
});

test("real REST transport: chat, refresh, same-task follow-up, artifacts and terminal state", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  const text = `workspace-${info.project.name}-${Date.now()}`;
  await send(page, text);
  await expect(page.locator(".assistant-message")).toContainText(
    `Reply from codex: ${text}`,
  );
  await expect(page.locator(".composer-label")).toContainText(
    "Compute released",
  );
  const taskId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
    "task",
  )!;
  expect(taskId).toBeTruthy();
  await page.reload();
  await expect(page.locator(".assistant-message")).toContainText(
    `Reply from codex: ${text}`,
  );
  await send(page, `follow-up-${text}`);
  await expect(page.locator(".assistant-message").last()).toContainText(
    `Reply from codex: follow-up-${text}`,
  );
  expect(
    new URLSearchParams(new URL(page.url()).hash.slice(1)).get("task"),
  ).toBe(taskId);
  const calls = (await (await request.get("/__fixture/calls")).json()).filter(
    (c: any) => c.taskId === taskId,
  );
  expect(calls.length).toBe(2);
  expect(new Set(calls.map((c: any) => c.instanceId)).size).toBe(1);
  await page.getByRole("button", { name: "Task details", exact: true }).click();
  await expect(page.locator(".artifact")).toHaveCount(2);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download result.txt", exact: true })
    .first()
    .click();
  expect((await download).suggestedFilename()).toBe("result.txt");
  await page.screenshot({ path: info.outputPath("task-details.png") });
  await page.getByRole("button", { name: "Close task details" }).click();
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("conversation.png") });
  await send(page, `finish-${text}`);
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.locator(".task-notice")).toContainText("Completed");
  await page.getByLabel("Agent", { exact: true }).selectOption("claude");
  await page.evaluate((id) => {
    location.hash = `task=${id}`;
  }, taskId);
  await expect(page.getByLabel("Agent", { exact: true })).toHaveValue("codex");
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.locator(".task-notice")).toContainText("Completed");
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "aira_session",
  );
  expect(errors).toEqual([]);
});

test("parallel agents, task switching preserves running execution, explicit cancellation", async ({
  page,
  request,
}, info) => {
  await login(page);
  const text = `hold-${info.project.name}-${Date.now()}`;
  await send(page, text);
  await expect(page.locator(".assistant-message")).toContainText(
    "Inspecting the workspace",
  );
  const taskId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
    "task",
  )!;
  await page.getByLabel("Agent", { exact: true }).selectOption("claude");
  await send(page, `second-${text.replace("hold", "parallel")}`);
  await expect(page.locator(".assistant-message")).toContainText(
    "Reply from claude",
  );
  await openTasks(page);
  await page
    .getByRole("button")
    .filter({ has: page.locator(".task-title", { hasText: text }) })
    .first()
    .click();
  await expect(page.getByLabel("Agent", { exact: true })).toHaveValue("codex");
  await expect(page.locator(".chat-header .status")).toHaveText("Working");
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await expect(page.locator(".task-notice")).toContainText("Canceled");
  const calls = (await (await request.get("/__fixture/calls")).json()).filter(
    (c: any) => c.taskId === taskId,
  );
  expect(calls.length).toBe(1);
  await noOverflow(page);
});

test("uncertain execution is read-only; logout clears browser access", async ({
  page,
}) => {
  await login(page);
  await send(page, "uncertain execution");
  await expect(page.locator(".task-notice")).toContainText(
    "Operator reconciliation required",
  );
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await openTasks(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
  expect((await page.request.get("/web-api/session")).status()).toBe(401);
});
