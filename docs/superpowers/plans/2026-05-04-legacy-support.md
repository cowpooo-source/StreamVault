# Legacy Device Support (Vite Legacy Plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for modern Smart TVs and Chromium-based TV boxes by configuring Vite to build a secondary, transpiled bundle with polyfills.

**Architecture:** 
1. Install `@vitejs/plugin-legacy` and `terser` in `streamvault` so production builds can emit both modern and legacy bundles.
2. Update `streamvault/vite.config.js` to enable the legacy plugin with an explicit compatibility matrix. Do not use `defaults` unless the support policy is intentionally broadened later.
3. Keep the existing React/Vite app structure intact. This change is build-time only: it should not require source refactors unless the build surfaces syntax or runtime gaps that the legacy plugin does not cover.

**Execution notes for the agent:**
- Work only in `streamvault/` for the actual build changes.
- The current app already uses `fetch`, optional chaining, nullish coalescing, `Promise`, `crypto.randomUUID`, and other modern APIs in `src/`, so verify the legacy bundle behavior instead of assuming the plugin polyfills every platform API.
- The legacy plugin handles legacy script emission and JS transpilation, but it does not magically fix unsupported browser APIs. If the build or runtime tests reveal a missing Web API, add a separate follow-up task for the specific polyfill or compatibility workaround.
- Use explicit targets that represent the supported vendor floor. For the current plan, the practical minimums are `chrome >= 68`, `safari >= 13`, `ios >= 13`, and `samsung >= 10`.
- Keep the build targets stable and easy to audit. If vendor guidance changes later, update this plan and the plugin config together.
- Roku is not part of this web target. Roku apps use SceneGraph/BrightScript, so supporting Roku requires a separate native Roku implementation rather than a Vite legacy build.

**Support matrix:**
- LG webOS 5.0 and newer
- Samsung Tizen 5.5 and newer
- Android TV / Google TV boxes with Chromium 68 or newer
- Not included: Roku web playback target

**Tech Stack:** Node.js, npm, Vite, `@vitejs/plugin-legacy`.

---

### Task 1: Install Dependencies

**Files:**
- Modify: `streamvault/package.json`
- Modify: `streamvault/package-lock.json`

- [ ] **Step 1: Install `@vitejs/plugin-legacy` and `terser`**
Run the npm install command within the `streamvault` directory to add the required development dependencies.
```bash
cd streamvault
npm install -D @vitejs/plugin-legacy terser
```
Expected:
- `package.json` gains `@vitejs/plugin-legacy` and `terser` under `devDependencies`
- `package-lock.json` records the new packages and their transitive dependencies

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
Expected:
- The file still remains an ES module
- Existing imports for `react`, `fs`, `path`, and `url` stay in place

- [ ] **Step 2: Add the plugin to the plugins array**
Update the `plugins` array in the `defineConfig` object to include the `legacy` plugin configuration. Use explicit targets for the legacy floor and keep the modern build behavior unchanged.
```javascript
export default defineConfig({
  plugins: [
    react(),
    swVersionPlugin(),
    legacy({
      targets: ['chrome >= 68', 'safari >= 13', 'ios >= 13', 'samsung >= 10'],
      additionalLegacyPolyfills: ['regenerator-runtime/runtime']
    })
  ],
// ... rest of config
```
Expected:
- `react()` and `swVersionPlugin()` remain first so current behavior is preserved
- The legacy plugin is added without changing the existing `build.target: "es2020"` setting unless the build fails and a separate compatibility fix is needed
- No other build or dev server behavior changes unless required by the plugin

- [ ] **Step 3: Run a test build**
Verify that the build process succeeds and generates both modern and legacy assets.
```bash
cd streamvault
npm run build
```
Expected output:
- Build exits successfully
- `dist/` contains both regular and legacy JS artifacts
- `dist/index.html` and `dist/landing.html` include the legacy script loader output produced by the plugin
- `dist/assets` contains files with `legacy` in the name alongside the modern bundles

- [ ] **Step 4: Verify the emitted HTML**
Open the generated HTML or inspect the output to confirm the legacy loader was injected.
```bash
Get-Content streamvault/dist/index.html
Get-Content streamvault/dist/landing.html
```
Expected:
- The output includes the legacy plugin's injected loader/runtime
- Modern modules still load normally for evergreen browsers

- [ ] **Step 5: Commit**
```bash
git add streamvault/vite.config.js
git commit -m "build: configure vite legacy plugin for older smart tv and android support"
```
