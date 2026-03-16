## Browser Testing (Playwright MCP)

Use the Playwright MCP server for visual testing — NOT agent-browser.

### How to use Playwright MCP
1. If browser not installed, call `mcp__playwright__browser_install` first
2. Navigate to the app: `mcp__playwright__browser_navigate` → `http://localhost:3004`
3. Take screenshots: `mcp__playwright__browser_take_screenshot`
4. Use `mcp__playwright__browser_snapshot` to get the accessibility tree for interacting with elements
5. Dev server runs on **port 3004**

### Viewport & device settings
- Test at iPhone viewport: 390x844 (iPhone 14) or 375x812 (iPhone 13)
- Use webkit browser when available — matches iOS Safari rendering
- Enable touch emulation and proper deviceScaleFactor (3x for retina)

### When to screenshot
- After any UI/layout change
- After CSS/styling updates
- When working on touch interactions or gestures
- Before marking a frontend task as done

### Do NOT use
- agent-browser (that's for a different system)
- Chrome mobile emulation (misses iOS webkit quirks)
