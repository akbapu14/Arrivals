const { test, expect } = require('@playwright/test');

test.describe('Arrivals Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads the page with correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Widebody Arrivals/);
    await expect(page.locator('#page-title')).toContainText('SFO Widebody Arrivals');
  });

  test('displays stats section', async ({ page }) => {
    await expect(page.locator('#total-count')).toBeVisible();
    await expect(page.locator('#airborne-count')).toBeVisible();
    await expect(page.locator('#next-eta')).toBeVisible();
  });

  test('loads flight data from API', async ({ page }) => {
    // Wait for flights to load (stats should update from "-")
    await expect(page.locator('#total-count')).not.toHaveText('-', { timeout: 30000 });
  });

  test('filter buttons work', async ({ page }) => {
    // Wait for data to load
    await expect(page.locator('#total-count')).not.toHaveText('-', { timeout: 30000 });

    // Click each filter button
    const filters = ['Upcoming', 'Airborne Now', 'Recently Landed', 'All'];
    for (const filter of filters) {
      const btn = page.locator(`.filter-btn:has-text("${filter}")`);
      await btn.click();
      await expect(btn).toHaveClass(/active/);
    }
  });

  test('airport selector changes title', async ({ page }) => {
    // Just test one airport to avoid timeout
    const btn = page.locator('.airport-btn:has-text("LAX")');
    await btn.click();

    await expect(page.locator('#page-title')).toContainText('LAX Widebody Arrivals');
    await expect(btn).toHaveClass(/active/);
  });

  test('custom airport input works', async ({ page }) => {
    const customInput = page.locator('#custom-airport');

    await customInput.fill('ORD');
    await customInput.press('Enter');

    await expect(page.locator('#page-title')).toContainText('ORD Widebody Arrivals');
    await expect(customInput).toHaveClass(/active/);
  });

  test('countdown timer is visible', async ({ page }) => {
    const countdown = page.locator('#countdown');
    await expect(countdown).toBeVisible();
  });

  test('last update shows after data loads', async ({ page }) => {
    // Wait for data to load
    await expect(page.locator('#total-count')).not.toHaveText('-', { timeout: 30000 });

    const lastUpdate = page.locator('#last-update');
    await expect(lastUpdate).not.toHaveText('-');
  });
});

test.describe('API', () => {
  test('schedule endpoint returns valid data', async ({ request }) => {
    const response = await request.get('/api/schedule?airport=SFO', { timeout: 45000 });
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data).toHaveProperty('arrivals');
    expect(data).toHaveProperty('source', 'flightradar24');
    expect(Array.isArray(data.arrivals)).toBeTruthy();

    // Check arrival structure if there are any
    if (data.arrivals.length > 0) {
      const arrival = data.arrivals[0];
      expect(arrival).toHaveProperty('flight');
      expect(arrival).toHaveProperty('type');
      expect(arrival).toHaveProperty('origin');
      expect(arrival).toHaveProperty('live');
      expect(arrival).toHaveProperty('altitude');
    }
  });
});
