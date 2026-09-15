/**
 * [F14-02 4A.1 §9] The `socket.io-client` test double, deliberately in its own
 * module with ZERO repository imports.
 *
 * `vi.mock` factories are hoisted above every import, so the factory cannot
 * close over anything imported by the test file. Keeping the double here lets a
 * test file write:
 *
 *   vi.mock('socket.io-client', async () => (await import('../../helpers/fake-socket-io')).socketIoClientMock());
 *
 * without creating a cycle through `paper-evidence` (which itself imports
 * `socket.io-client`).
 *
 * This intercepts the external package the privileged socket calls — NOT a
 * repository-exported production API. Patching a repo export is precisely what
 * no longer works, and `prototype-trust-bypass.test.ts` proves it.
 */

type Listener = (...args: unknown[]) => void;

/** The raw socket.io-client socket the privileged production socket wraps. */
export class FakeIoSocket {
  public connected = false;
  public readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  public connect(): void {
    this.connected = true;
    this.trigger('connect');
  }

  public disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.trigger('disconnect', 'io client disconnect');
  }

  public on(event: string, listener: Listener): void {
    let set = this.#listeners.get(event);
    if (set === undefined) { set = new Set<Listener>(); this.#listeners.set(event, set); }
    set.add(listener);
  }

  public off(event: string, listener: Listener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  public emit(event: string, ...args: unknown[]): void {
    this.emitted.push({ event, args });
  }

  /** Delivers a server frame into the privileged socket's own callback. */
  public trigger(event: string, ...args: unknown[]): void {
    for (const listener of Array.from(this.#listeners.get(event) ?? [])) listener(...args);
  }
}

/** Every socket the mocked package has handed out, in creation order. */
export const createdFakeSockets: FakeIoSocket[] = [];

export function socketIoClientMock(): { default: () => FakeIoSocket } {
  return {
    default: (): FakeIoSocket => {
      const socket = new FakeIoSocket();
      createdFakeSockets.push(socket);
      return socket;
    },
  };
}
