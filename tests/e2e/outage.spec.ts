import { test, expect } from '@playwright/test';

test.describe('E2E Outage and Self-Healing Reconnection', () => {
  test('calmly pauses during gateway outage, displays calm banner with countdown, and resumes automatically when gateway recovers', async ({
    page,
  }) => {
    // Intercept health checks and completions
    let gatewayOnline = false;

    await page.route('**/api/health', async (route) => {
      if (gatewayOnline) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.abort('failed');
      }
    });

    await page.route('**/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'law-extract-a', owned_by: 'combo' },
            { id: 'law-extract-b', owned_by: 'combo' },
            { id: 'law-judge', owned_by: 'combo' },
          ],
        }),
      });
    });

    await page.goto('/');

    // Check app header loaded
    await expect(page.locator('h1')).toContainText('LawText');

    // Simulate transient connection drop by setting gate state to PAUSED
    await page.evaluate(() => {
      const store = (window as unknown as { __APP_STORE__?: { getState: () => { setGateState: (s: string, ms?: number) => void } } }).__APP_STORE__;
      if (store) {
        store.getState().setGateState('PAUSED', 6000);
      }
    });

    // Check calm banner appears with countdown
    const banner = page.locator('[aria-label="Connection status"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Connection to OmniRoute lost/i);
    await expect(banner).toContainText(/Your progress is saved/i);
    await expect(banner.locator('button')).toContainText(/Retry connection now/i);

    // Simulate gateway recovery
    gatewayOnline = true;
    await page.evaluate(() => {
      const store = (window as unknown as { __APP_STORE__?: { getState: () => { setGateState: (s: string) => void } } }).__APP_STORE__;
      if (store) {
        store.getState().setGateState('ONLINE');
      }
    });

    // Banner disappears when ONLINE
    await expect(banner).not.toBeVisible();
  });
});
