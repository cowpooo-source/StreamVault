# Legacy Device Support (Vite Legacy Plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for older Smart TVs (WebOS, Tizen) and legacy Android devices by configuring Vite to build a secondary, transpiled bundle with polyfills.

**Architecture:** 
1. Install `@vitejs/plugin-legacy` and `terser` (required for minifying the legacy bundle).
2. Update `vite.config.js` to include the legacy plugin. This plugin will analyze the codebase and automatically inject polyfills (like `Promise`, `fetch`, etc.) and transpile modern ES2020 syntax (like optional chaining `?.`) down to ES5/ES2015, which is compatible with older browser engines used by legacy Smart TVs.
3. The resulting build will produce two sets of assets: modern modules (for modern browsers) and legacy nomodule scripts. The HTML will be structured to load the correct version based on the browser's capabilities.

**Tech Stack:** Node.js, npm, Vite, `@vitejs/plugin-legacy`.

---

### Task 1: Install Dependencies

**Files:**
- Modify: `streamvault/package.json`

- [ ] **Step 1: Install `@vitejs/plugin-legacy` and `terser`**
Run the npm install command within the `streamvault` directory to add the required development dependencies.
```bash
cd streamvault
npm install -D @vitejs/plugin-legacy terser
```

- [ ] **Step 2: Commit**
```bash
git add streamvault/package.json streamvault/package-lock.json
git commit -m "chore: install @vitejs/plugin-legacy and terser for legacy device support"
```

### Task 2: Configure Vite for Legacy Builds

**Files:**
- Modify: `streamvault/vite.config.js`

- [ ] **Step 1: Import the legacy plugin**
At the top of `streamvault/vite.config.js`, import the plugin.
```javascript
import legacy from '@vitejs/plugin-legacy'
```

- [ ] **Step 2: Add the plugin to the plugins array**
Update the `plugins` array in the `defineConfig` object to include the `legacy` plugin configuration. We will target browsers that support ES modules (for the modern build) and provide a broader target for the legacy build, explicitly asking for polyfills.
```javascript
export default defineConfig({
  plugins: [
    react(),
    swVersionPlugin(),
    legacy({
      targets: ['defaults', 'not IE 11', 'chrome >= 49', 'safari >= 10', 'ios >= 10', 'samsung >= 4'],
      additionalLegacyPolyfills: ['regenerator-runtime/runtime']
    })
  ],
// ... rest of config
```

- [ ] **Step 3: Run a test build**
Verify that the build process succeeds and generates both modern and legacy assets.
```bash
cd streamvault
npm run build
```
Expected output should show `dist/assets` containing files like `main-legacy-XYZ.js` alongside the regular `main-XYZ.js`.

- [ ] **Step 4: Commit**
```bash
git add streamvault/vite.config.js
git commit -m "build: configure vite legacy plugin for older smart tv and android support"
```