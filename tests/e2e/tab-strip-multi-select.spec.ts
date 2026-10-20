import { expect, test } from './helpers/orca-app'

test('Shift and Cmd/Ctrl click select tabs, and the menu closes the selection', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1200, height: 900 })
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    for (let index = tabs.length; index < 4; index++) {
      state.createTab(worktreeId)
    }
  })

  const tabs = orcaPage.locator('[data-testid="sortable-tab"]:visible')
  const selected = orcaPage.locator('[data-testid="sortable-tab"][data-selected="true"]:visible')
  await expect(tabs).toHaveCount(4)
  const keepTitle = await tabs.nth(3).getAttribute('data-tab-title')
  const toggleModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  await tabs.nth(0).click()
  await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true')
  await tabs.nth(2).click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(3)
  // A selecting click leaves the active tab where it was.
  await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true')

  await tabs.nth(1).click({ modifiers: [toggleModifier] })
  await expect(selected).toHaveCount(2)
  await tabs.nth(1).click({ modifiers: [toggleModifier] })
  await expect(selected).toHaveCount(3)

  await orcaPage.keyboard.press('Escape')
  await expect(selected).toHaveCount(0)

  await tabs.nth(2).click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(3)
  const screenshot = testInfo.outputPath('tab-strip-multi-select.png')
  await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('tab-strip-multi-select', { path: screenshot, contentType: 'image/png' })

  await tabs.nth(1).click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Close Selected Tabs' }).click()
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toHaveAttribute('data-tab-title', keepTitle ?? '')
})
