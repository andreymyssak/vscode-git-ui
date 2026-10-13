import { type Request, test as base } from '@playwright/test';

import { recoverBrowserNavigation } from './browser-navigation';

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const navigate = page.goto.bind(page);

    page.goto = (...args) =>
      recoverBrowserNavigation({
        navigate: () => navigate(...args),
        observeFailures: (record) => {
          const failed = (request: Request) => {
            const failure = request.failure();

            if (
              failure &&
              ['document', 'script', 'stylesheet'].includes(
                request.resourceType(),
              ) &&
              request.frame() === page.mainFrame()
            )
              record(new Error(`${request.url()}: ${failure.errorText}`));
          };

          page.on('requestfailed', failed);

          return () => {
            page.off('requestfailed', failed);
          };
        },
        report: (error) => {
          testInfo.annotations.push({
            type: 'navigation recovery',
            description: error.message,
          });
          console.warn(
            `Retrying browser socket allocation once: ${error.message}`,
          );
        },
      });
    try {
      await use(page);
    } finally {
      page.goto = navigate;
    }
  },
});

export type { Locator, Page } from '@playwright/test';
export { expect } from '@playwright/test';
