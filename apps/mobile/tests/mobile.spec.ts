import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';

async function login(page: Page) {
  await page.route('https://atrishub.com/api/auth/login', async route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    expect(route.request().postDataJSON()).toEqual({ email: 'user@example.com', password: 'example-password' });
    return route.fulfill({ json: { token: 'test-owner', user: { username: 'tester', name: 'Test User' } }, headers });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in to AtrisHub' }).click();
  await page.getByLabel('Email or username').fill('user@example.com');
  await page.getByLabel('Password').fill('example-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your account' })).toBeVisible();
}
async function pair(page: Page, request: APIRequestContext) {
  await login(page);
  const config = await (await request.get('http://127.0.0.1:4191/fixture')).json();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect desktop', exact: true }).click();
  await page.getByText('Enter pairing code manually').click();
  await page.getByLabel('Pairing code').fill(config.code);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect desktop', exact: true }).click();
  await expect(page.getByText('Approve your phone on desktop', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const approval = await (await request.get(`http://127.0.0.1:4191/approve?id=${config.id}`)).json();
  expect(approval.devices.some((device: { approved: boolean }) => device.approved)).toBeTruthy();
  await expect(page.getByText('Test Desktop')).toBeVisible({ timeout: 10000 });
  return config;
}
async function chat(page: Page) {
  await page.getByRole('button', { name: /AtrisAgent.*agents/ }).click();
  await page.getByRole('button', { name: /Builder/ }).click();
  await expect(page.getByText('Ready to continue the implementation.')).toBeVisible();
}

test('real WebSocket relay: pair, approve, message, model change, revoke', async ({ page, request }, testInfo) => {
  const config = await pair(page, request);
  await expect(page.getByRole('img', { name: 'AtrisAgent logo' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('connected-workspaces.png'), scale: 'css' });
  await chat(page);
  await page.getByRole('textbox', { name: 'Message Builder' }).fill('Please continue.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('The desktop received your message.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('agent-conversation.png'), scale: 'css' });
  await expect(page.getByRole('textbox', { name: 'Message Builder' })).toHaveValue('');
  expect((await (await request.get(`http://127.0.0.1:4191/stats?id=${config.id}`)).json()).writes).toBe(1);
  await page.getByRole('button', { name: /GPT Terra/ }).click();
  await page.getByRole('button', { name: 'medium', exact: true }).click();
  await expect(page.getByRole('button', { name: /GPT Terra.*medium/ })).toBeVisible();
  await page.getByRole('button', { name: 'Agent permissions, questions and memory' }).click();
  await expect(page.getByText('Project decision')).toBeVisible();
  await page.getByRole('radio', { name: 'Yes', exact: true }).check();
  await page.getByRole('button', { name: 'Reply to agent' }).click();
  await expect(page.getByText('Should the agent continue?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable auto-approve' }).click();
  await expect(page.getByRole('button', { name: 'Disable auto-approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await request.get(`http://127.0.0.1:4191/revoke?id=${config.id}`);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('QR photo pairs and workspace details open', async ({ page, request }, testInfo) => {
  await login(page);
  const config = await (await request.get('http://127.0.0.1:4191/fixture')).json();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect desktop', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('connect-qr.png'), scale: 'css' });
  const qrPage = await page.context().newPage();
  await qrPage.setContent(renderToStaticMarkup(React.createElement(QRCodeSVG, { value: config.code, size: 240, marginSize: 4 })));
  const qr = await qrPage.locator('svg').screenshot();
  await qrPage.close();
  await page.getByLabel('Scan QR code').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: qr });
  await expect(page.getByText('Approve your phone on desktop', { exact: true })).toBeVisible();
  await request.get(`http://127.0.0.1:4191/approve?id=${config.id}`);
  await expect(page.getByText('Test Desktop')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /AtrisAgent.*agents/ }).click();
  await page.getByRole('button', { name: /Release plan/ }).click();
  await expect(page.getByText('Ship the mobile update.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: /Build project/ }).click();
  await expect(page.getByText('Run tests', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mission-detail.png'), scale: 'css' });
});

test('live camera QR stream pairs desktop automatically', async ({ page, request }) => {
  await login(page);
  const config = await (await request.get('http://127.0.0.1:4191/fixture')).json();
  const qrPage = await page.context().newPage();
  await qrPage.setContent(renderToStaticMarkup(React.createElement(QRCodeSVG, { value: config.code, size: 280, marginSize: 4 })));
  const qr = await qrPage.locator('svg').screenshot();
  await qrPage.close();
  const qrDataUrl = `data:image/png;base64,${qr.toString('base64')}`;
  await page.evaluate(async (dataUrl: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load QR image'));
    });
    const draw = () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 20, 20, 280, 280);
    };
    draw();
    const timer = window.setInterval(draw, 100);
    const stream = canvas.captureStream(15);
    for (const track of stream.getTracks()) {
      const origStop = track.stop.bind(track);
      track.stop = () => {
        (window as any).__qrTrackStopped = true;
        window.clearInterval(timer);
        origStop();
      };
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => stream,
      },
    });
  }, qrDataUrl);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect desktop', exact: true }).click();
  await expect(page.getByTestId('qr-scanner-video')).toBeVisible();
  await expect(page.getByText('Approve your phone on desktop', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => (window as any).__qrTrackStopped)).toBe(true);
  await request.get(`http://127.0.0.1:4191/approve?id=${config.id}`);
  await expect(page.getByText('Test Desktop')).toBeVisible({ timeout: 10000 });
});

test('uncertain delivery retains the draft', async ({ page, request }) => {
  await pair(page, request); await chat(page);
  await page.getByRole('textbox', { name: 'Message Builder' }).fill('uncertain');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('textbox', { name: 'Message Builder' })).toHaveValue('uncertain');
});

test('short narrow screen keeps composer in view', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 650 });
  await pair(page, request); await chat(page);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
});

test('no pairing means no fake desktop connection; malformed code is rejected', async ({ page }) => {
  await login(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect desktop', exact: true }).click();
  await page.getByText('Enter pairing code manually').click();
  await page.getByLabel('Pairing code').fill('invalid');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect desktop', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('pairing code');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-owner');
});

test('native session adapter restores and deletes a secure token without browser storage', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command === 'load_mobile_token') return 'saved-test-token';
      if (command === 'delete_mobile_token') { (window as any).__sessionDeleted = true; return; }
      throw new Error('Unexpected native call');
    } };
  });
  await page.route('https://atrishub.com/api/auth/me', route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    expect(route.request().headers().authorization).toBe('Bearer saved-test-token');
    return route.fulfill({ json: { user: { username: 'restored-user' } }, headers });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'AtrisHub account' }).click();
  await expect(page.getByText('Session saved in native secure storage.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Welcome back' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__sessionDeleted)).toBeTruthy();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('saved-test-token');
});

test('mobile scale is locked during pinch, double tap and input focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /maximum-scale=1.*user-scalable=no/);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', { x: 180, y: 300, scaleFactor: 2, gestureSourceType: 'touch' });
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  for (let tap = 0; tap < 2; tap++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 300 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await page.getByRole('button', { name: 'Sign in to AtrisHub' }).click();
  const input = page.getByLabel('Email or username');
  await input.focus();
  expect(await input.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  expect(await page.evaluate(() => {
    const event = new Event('gesturechange', { bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBeTruthy();
});
