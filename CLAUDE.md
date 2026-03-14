## Browser Testing (Playwright WebKit)

Use Playwright with WebKit for visual testing — NOT agent-browser.

### Setup
- Already installed: `@playwright/test` + webkit browser
- MCP server available for screenshots

### How to test
1. Take a screenshot of the running dev server to see current state
2. Use webkit browser (not chromium) — this matches iOS Safari rendering
3. Always test at iPhone viewport: 390x844 (iPhone 14) or 375x812 (iPhone 13)
4. Enable touch emulation and proper deviceScaleFactor (3x for retina)

### When to screenshot
- After any UI/layout change
- After CSS/styling updates
- When working on touch interactions or gestures
- Before marking a frontend task as done

### Do NOT use
- agent-browser (that's for a different system)
- Chrome mobile emulation (misses iOS webkit quirks)
