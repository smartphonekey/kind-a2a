// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:8095';

test('Access UI: one sign-in, stream renewal without replay, private owners and logout', async ({ page, browser }, info) => {
  await page.context().request.get(`${origin}/__fixture/login?user=alice`);
  await page.goto(`${origin}/ui/`);
  await expect(page.getByLabel('Access token')).toHaveCount(0);
  const prompt = `access-${info.project.name}-${Date.now()}`;
  await page.getByLabel('Message', { exact: true }).fill(prompt);
  let sends = 0, subscriptions = 0;
  page.on('request', r => {
    if (r.url().endsWith('/message:stream')) sends++;
    if (r.url().endsWith(':subscribe')) subscriptions++;
  });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.assistant-message')).toContainText(`Reply from codex: ${prompt}`);
  await expect(page.locator('.composer-label')).toContainText('Compute released');
  expect(sends).toBe(1);
  expect(subscriptions).toBeGreaterThan(0);
  const taskId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('task')!;
  expect(taskId).toBeTruthy();
  await page.reload();
  await expect(page.locator('.assistant-message')).toContainText(prompt);
  const bob = await browser.newContext();
  try {
    await bob.request.get(`${origin}/__fixture/login?user=bob`);
    const read = await bob.request.get(`${origin}/web-api/a2a/tasks/${taskId}`, { headers: { 'A2A-Version': '1.0' } });
    expect(read.status()).toBe(404);
    const list = await bob.request.get(`${origin}/web-api/a2a/tasks`, { headers: { 'A2A-Version': '1.0' } });
    expect(await list.text()).not.toContain(taskId);
  } finally { await bob.close(); }
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.screenshot({ path: info.outputPath('access-workspace.png') });
  const menu = page.getByRole('button', { name: 'Open task list' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/cdn-cgi/access/logout`);
  expect((await page.context().request.get(`${origin}/web-api/session`)).status()).toBe(401);
});
