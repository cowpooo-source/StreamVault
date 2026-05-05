import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as emailService from '../src/email';

describe('email service', () => {
  const mockSend = vi.fn();
  const mockResendInstance = {
    emails: { send: mockSend }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    emailService.setResend(mockResendInstance);
  });

  it('sendVerificationEmail calls resend with correct data', async () => {
    mockSend.mockResolvedValue({ data: { id: '123' }, error: null });

    const result = await emailService.sendVerificationEmail('test@example.com', 'token123', { username: 'testuser' });
    
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: ['test@example.com'],
      subject: "Activate your Portal Heaven account",
    }));
  });

  it('sendPasswordResetEmail calls resend with correct data', async () => {
    mockSend.mockResolvedValue({ data: { id: '456' }, error: null });

    const result = await emailService.sendPasswordResetEmail('reset@example.com', 'reset-token', { username: 'resetuser' });
    
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: ['reset@example.com'],
      subject: "Reset your Portal Heaven password",
    }));
  });

  it('sendEmail returns false on Resend error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'API Error' } });

    const result = await emailService.sendEmail({ to: 'fail@example.com', subject: 'test', html: '<p>test</p>' });
    
    expect(result).toBe(false);
  });

  it('sendEmail returns false on exception', async () => {
    mockSend.mockRejectedValue(new Error('Network error'));

    const result = await emailService.sendEmail({ to: 'fail@example.com', subject: 'test', html: '<p>test</p>' });
    
    expect(result).toBe(false);
  });
});
