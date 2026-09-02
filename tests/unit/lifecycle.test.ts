import { describe, it, expect, vi } from 'vitest';
import { GracefulShutdownManager } from '../../src/app/lifecycle/shutdown';

describe('Lifecycle & Graceful Shutdown', () => {
  it('registers and executes shutdown hooks in sequence', async () => {
    const manager = new GracefulShutdownManager({ timeoutMs: 1000 });
    const hook1 = vi.fn().mockResolvedValue(undefined);
    const hook2 = vi.fn().mockResolvedValue(undefined);

    manager.addHook(hook1);
    manager.addHook(hook2);

    await manager.shutdown('test-signal');

    expect(hook1).toHaveBeenCalledTimes(1);
    expect(hook2).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when shutdown is invoked repeatedly', async () => {
    const manager = new GracefulShutdownManager({ timeoutMs: 1000 });
    const hook = vi.fn().mockResolvedValue(undefined);

    manager.addHook(hook);

    // Call twice in parallel
    await Promise.all([manager.shutdown('first'), manager.shutdown('second')]);

    // Hook must only run once
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('continues executing subsequent hooks even if one throws', async () => {
    const manager = new GracefulShutdownManager({ timeoutMs: 1000 });
    const failingHook = vi.fn().mockRejectedValue(new Error('Boom in hook'));
    const succeedingHook = vi.fn().mockResolvedValue(undefined);

    manager.addHook(failingHook);
    manager.addHook(succeedingHook);

    await expect(manager.shutdown('test-error-resilience')).resolves.not.toThrow();
    expect(failingHook).toHaveBeenCalledTimes(1);
    expect(succeedingHook).toHaveBeenCalledTimes(1);
  });
});

