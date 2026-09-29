// Why: electron-chrome-extensions imports the real Electron runtime, which unit tests don't have.
export function injectBrowserAction(): void {}
