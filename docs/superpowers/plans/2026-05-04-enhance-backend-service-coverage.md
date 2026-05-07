# Enhance Backend Service Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase test coverage for `email.js` and `system.js` to >80% by implementing/refactoring and adding unit tests.

**Architecture:** Refactor `email.js` to use the `Resend` library and implement `getSystemMetrics` in `system.js` to aggregate system statistics. Add comprehensive tests using Vitest and `vi.mock`.

**Tech Stack:** Node.js, Vitest, Resend, OS/FS modules.

---

### Task 1: Refactor `stalker-proxy/src/services/system.js`

**Files:**
- Modify: `stalker-proxy/src/services/system.js`

- [ ] **Step 1: Add `os` import and implement `getSystemMetrics`**

```javascript
const os = require("os");
// ... existing imports

// ... existing functions

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  let load = [0, 0, 0];
  try {
    // Attempt to read from /proc/loadavg for linux-specific precision if needed, fallback to os.loadavg()
    const loadData = fs.readFileSync("/proc/loadavg", "utf8");
    load = loadData.split(/\s+/).slice(0, 3).map(parseFloat);
  } catch {
    load = os.loadavg();
  }

  return {
    cpu: {
      load: os.loadavg(),
      cores: os.cpus().length,
    },
    mem: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percent: Math.round((usedMem / totalMem) * 100)
    },
    uptime: os.uptime(),
    load: load
  };
}

// Update exports
module.exports = {
  // ... existing
  getSystemMetrics
};
```

### Task 2: Refactor `stalker-proxy/src/email.js`

**Files:**
- Modify: `stalker-proxy/src/email.js`

- [ ] **Step 1: Switch to `Resend` and implement requested functions**

```javascript
const { Resend } = require("resend");
const RESEND_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;
const FROM_EMAIL = process.env.SMTP_FROM || "onboarding@resend.dev";

// ... keep escapeHtml

async function sendVerificationEmail(email, token, user) {
  if (!resend) {
    console.warn("Email: RESEND_API_KEY not set, skipping verification email to", email);
    return false;
  }
  const link = `${process.env.APP_URL || "http://localhost:3000"}?action=activate&token=${token}`;
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Activate your Portal Heaven account",
      html: `<p>Hi ${escapeHtml(user.username)},</p><p>Link: ${link}</p>`
    });
    return true;
  } catch (e) {
    console.error("Resend error:", e);
    return false;
  }
}

async function sendPasswordResetEmail(email, token, user) {
  if (!resend) {
    console.warn("Email: RESEND_API_KEY not set, skipping reset email to", email);
    return false;
  }
  const link = `${process.env.APP_URL || "http://localhost:3000"}?action=reset-password&token=${token}`;
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Reset your Portal Heaven password",
      html: `<p>Hi ${escapeHtml(user.username)},</p><p>Link: ${link}</p>`
    });
    return true;
  } catch (e) {
    console.error("Resend error:", e);
    return false;
  }
}

// Keep existing exports but update/alias if needed for compatibility
module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  // ... other existing exports updated to use resend if possible, or just focus on these two
};
```

### Task 3: Create tests for `system.js`

**Files:**
- Create: `stalker-proxy/tests/system.test.js`

- [ ] **Step 1: Write tests for `getSystemMetrics`**

```javascript
import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import { getSystemMetrics } from '../src/services/system';

vi.mock('os');
vi.mock('fs');

describe('system service', () => {
  it('getSystemMetrics returns correct structure and values', () => {
    os.totalmem.mockReturnValue(16000000000);
    os.freemem.mockReturnValue(8000000000);
    os.uptime.mockReturnValue(12345);
    os.cpus.mockReturnValue([{}, {}, {}, {}]);
    os.loadavg.mockReturnValue([1.5, 1.2, 1.0]);
    fs.readFileSync.mockReturnValue("0.50 0.40 0.30 1/100 12345");

    const metrics = getSystemMetrics();
    expect(metrics.cpu.cores).toBe(4);
    expect(metrics.mem.percent).toBe(50);
    expect(metrics.load[0]).toBe(0.5);
    expect(metrics.uptime).toBe(12345);
  });

  it('getSystemMetrics falls back to os.loadavg if fs fails', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error(); });
    os.loadavg.mockReturnValue([1.5, 1.2, 1.0]);
    
    const metrics = getSystemMetrics();
    expect(metrics.load[0]).toBe(1.5);
  });
});
```

### Task 4: Create tests for `email.js`

**Files:**
- Create: `stalker-proxy/tests/email.test.js`

- [ ] **Step 1: Write tests for `sendVerificationEmail` and `sendPasswordResetEmail`**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendVerificationEmail, sendPasswordResetEmail } from '../src/email';

const mockSend = vi.fn();
vi.mock('resend', () => {
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: { send: mockSend }
    }))
  };
});

describe('email service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sendVerificationEmail calls resend with correct data', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    // Re-import or handle resend initialization
    mockSend.mockResolvedValue({ data: { id: '123' } });

    const result = await sendVerificationEmail('test@example.com', 'token123', { username: 'testuser' });
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: expect.stringContaining('Activate')
    }));
  });

  it('returns false if RESEND_API_KEY is missing', async () => {
    // Need to handle the singleton 'resend' in email.js
  });
});
```

### Task 5: Verification

- [ ] **Step 1: Run coverage and verify >80%**
Run: `cd stalker-proxy && npx vitest run --coverage`
Verify `email.js` and `system.js` in the output.
