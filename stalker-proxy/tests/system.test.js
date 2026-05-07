import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import systemService from '../src/services/system';

describe('system service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getSystemMetrics returns correct structure and values', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(16000000000);
    vi.spyOn(os, 'freemem').mockReturnValue(8000000000);
    vi.spyOn(os, 'uptime').mockReturnValue(12345);
    vi.spyOn(os, 'cpus').mockReturnValue([{}, {}, {}, {}]);
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1.2, 1.0]);
    
    vi.spyOn(fs, 'readFileSync').mockReturnValue("0.50 0.40 0.30 1/100 12345");

    const metrics = systemService.getSystemMetrics();
    
    expect(metrics.cpu.cores).toBe(4);
    expect(metrics.mem.total).toBe(16000000000);
    expect(metrics.load).toEqual([0.5, 0.4, 0.3]);
    expect(metrics.uptime).toBe(12345);
  });

  it('getSystemMetrics falls back to os.loadavg if fs.readFileSync fails', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(16000000000);
    vi.spyOn(os, 'freemem').mockReturnValue(8000000000);
    vi.spyOn(os, 'uptime').mockReturnValue(12345);
    vi.spyOn(os, 'cpus').mockReturnValue([{}]);
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1.2, 1.0]);
    
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('File not found');
    });

    const metrics = systemService.getSystemMetrics();
    expect(metrics.load).toEqual([1.5, 1.2, 1.0]);
  });

  it('getSystemMetrics handles malformed /proc/loadavg', () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1.2, 1.0]);
    vi.spyOn(fs, 'readFileSync').mockReturnValue("not a number");

    const metrics = systemService.getSystemMetrics();
    expect(metrics.load[0]).toBeNaN();
  });
});
