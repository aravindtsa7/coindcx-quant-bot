import { FakeClock } from '../../../../src/integration/coindcx/clock';
import { StreamScheduler } from '../../../../src/integration/coindcx/websocket/public-stream';
import { FakeCoinDcxSocketFactory } from '../../../../src/integration/coindcx/websocket/socket-adapter';

export class ManualScheduler implements StreamScheduler {
  private timerIdCounter = 1;
  private currentTime = 0;
  public readonly timers = new Map<number, { callback: () => void; delayMs: number; dueTime: number }>();
  public readonly intervals = new Map<number, { callback: () => void; intervalMs: number }>();

  public setTimeout(callback: () => void, delayMs: number): number {
    const id = this.timerIdCounter++;
    this.timers.set(id, { callback, delayMs, dueTime: this.currentTime + delayMs });
    return id;
  }

  public clearTimeout(id: number | NodeJS.Timeout): void {
    this.timers.delete(Number(id));
  }

  public setInterval(callback: () => void, intervalMs: number): number {
    const id = this.timerIdCounter++;
    this.intervals.set(id, { callback, intervalMs });
    return id;
  }

  public clearInterval(id: number | NodeJS.Timeout): void {
    this.intervals.delete(Number(id));
  }

  public advanceTime(ms: number): void {
    this.currentTime += ms;
    const ready = Array.from(this.timers.entries())
      .filter(([_, t]) => t.dueTime <= this.currentTime)
      .sort((a, b) => a[1].dueTime - b[1].dueTime);

    for (const [id, timer] of ready) {
      this.timers.delete(id);
      timer.callback();
    }
  }

  public runAllTimers(): void {
    const callbacks = Array.from(this.timers.values()).map((t) => t.callback);
    this.timers.clear();
    for (const cb of callbacks) {
      cb();
    }
  }

  public triggerIntervals(): void {
    const callbacks = Array.from(this.intervals.values()).map((t) => t.callback);
    for (const cb of callbacks) {
      cb();
    }
  }

  public get activeTimerCount(): number {
    return this.timers.size;
  }

  public get activeIntervalCount(): number {
    return this.intervals.size;
  }
}

export function createTestStreamContext() {
  const clock = new FakeClock(1700000000000);
  const scheduler = new ManualScheduler();
  const socketFactory = new FakeCoinDcxSocketFactory();
  let fakeRngValue = 0.5;
  const rng = () => fakeRngValue;

  return {
    clock,
    scheduler,
    socketFactory,
    rng,
    setRng: (val: number) => {
      fakeRngValue = val;
    },
  };
}
