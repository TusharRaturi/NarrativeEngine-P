import { test, expect } from '@playwright/test';

test.describe('Campaign Flow', () => {
  test('should load the initial app, open campaign, and render messages', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
    
    // The title should be present.
    await expect(page).toHaveTitle(/Narrative Engine/i);

    // Wait for the main UI to render (e.g., sidebars, navigation)
    // We assume there is some container with an ID of root
    const rootContainer = page.locator('#root');
    await expect(rootContainer).toBeVisible({ timeout: 15000 });
  });
});
