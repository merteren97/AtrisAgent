import { expect, test, type Page } from '@playwright/test';

const agent = { id: 'a1', conversationId: 'c1', name: 'Builder', runtime: 'Codex', model: 'GPT 6.1 Terra', reasoning: 'high', status: 'working', summary: 'Implementing the workspace changes.' };
const workspaces = [{ id: 'w1', name: 'AtrisAgent', agents: [agent] }, { id: 'w2', name: 'AtrisHub', agents: [] }];

async function mockBridge(page: Page, failSend = false) {
  const messages = [{ id: 'm1', role: 'assistant', text: 'I am working on the implementation.' }];
  await page.route('**/api/mobile/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: { connected: true, desktopName: 'Studio PC' } });
    if (url.pathname.endsWith('/workspaces')) return route.fulfill({ json: workspaces });
    if (url.pathname.endsWith('/models')) return route.fulfill({ json: [{ id: 'model-1', name: 'GPT 6.1 Terra', runtime: 'Codex', reasoning: ['medium', 'high'], available: true }] });
    if (url.pathname.endsWith('/model') && request.method() === 'PATCH') return route.fulfill({ json: { ...agent, reasoning: request.postDataJSON().reasoning } });
    if (url.pathname.endsWith('/messages') && request.method() === 'POST') {
      if (failSend) return route.abort('connectionreset');
      const body = request.postDataJSON();
      expect(body).toMatchObject({ workspaceId: 'w1', conversationId: 'c1', text: 'Please continue.' });
      expect(body.id).toBeTruthy();
      messages.push({ id: 'm2', role: 'user', text: body.text });
      return route.fulfill({ json: { status: 'delivered' } });
    }
    if (url.pathname.endsWith('/messages')) return route.fulfill({ json: messages });
    return route.fulfill({ status: 404 });
  });
}

async function openChat(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /AtrisAgent.*agent/ }).click();
  await page.getByRole('button', { name: /Builder/ }).click();
}

test('workspace and agent conversation: send and choose reasoning', async ({ page }) => {
  await mockBridge(page);
  await page.goto('/');
  await expect(page.getByText('Studio PC')).toBeVisible();
  await expect(page.getByRole('img', { name: 'AtrisAgent logo' })).toBeVisible();
  expect(await page.getByRole('img', { name: 'AtrisAgent logo' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Find a workspace' }).fill('Agent');
  await expect(page.getByRole('button', { name: /AtrisHub 0 agents/ })).toHaveCount(0);
  await page.getByRole('button', { name: /AtrisAgent.*agent/ }).click();
  await expect(page.getByText('Working')).toBeVisible();
  await page.getByRole('button', { name: /Builder/ }).click();
  await expect(page.getByText('I am working on the implementation.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Builder' }).fill('Please continue.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Please continue.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Builder' })).toHaveValue('');
  await page.getByRole('button', { name: /GPT 6.1 Terra/ }).click();
  await expect(page.getByRole('dialog', { name: 'Model & reasoning' })).toBeVisible();
  await page.getByRole('button', { name: 'medium', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /GPT 6.1 Terra.*medium/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('uncertain delivery preserves the draft and warns before retry', async ({ page }) => {
  await mockBridge(page, true);
  await openChat(page);
  await page.getByRole('textbox', { name: 'Message Builder' }).fill('Please continue.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('textbox', { name: 'Message Builder' })).toHaveValue('Please continue.');
});

test('unavailable connection is honestly shown', async ({ page }) => {
  await page.route('**/api/mobile/**', route => route.abort());
  await page.goto('/');
  await expect(page.getByText('Desktop not connected')).toBeVisible();
  await expect(page.getByText('Secure mobile pairing is not available yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('composer stays reachable on a short narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 });
  await mockBridge(page);
  await openChat(page);
  const composer = page.getByRole('textbox', { name: 'Message Builder' });
  const box = await composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(650);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
});

test('AtrisHub sign-in does not claim the desktop is paired', async ({ page }) => {
  await page.route('**/api/mobile/**', route => route.abort());
  await page.route('https://atrishub.com/api/auth/login', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
    expect(route.request().postDataJSON()).toEqual({ email: 'user@example.com', password: 'example-password' });
    return route.fulfill({ json: { token: 'test-session-token', user: { username: 'test-user', name: 'Test User' } }, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in to AtrisHub' }).click();
  const dialog = page.getByRole('dialog', { name: 'Welcome back' });
  await dialog.getByLabel('Email or username').fill('user@example.com');
  await dialog.getByLabel('Password').fill('example-password');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your account' })).toContainText('Signed in as Test User');
  await expect(page.getByRole('dialog')).toContainText('does not connect your computer yet');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-session-token');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('dialog', { name: 'Welcome back' })).toBeVisible();
});

test('AtrisHub invalid credentials are shown without connecting', async ({ page }) => {
  await page.route('**/api/mobile/**', route => route.abort());
  await page.route('https://atrishub.com/api/auth/login', route => route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 401, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in to AtrisHub' }).click();
  await page.getByLabel('Email or username').fill('unknown@example.com');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await expect(page.getByText('Desktop not connected')).toBeVisible();
});
