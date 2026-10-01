/** Internal revocation-only association. Never readiness or mutation authority. */
const ISSUER = Object.freeze({ purpose: 'practical-cancel-local-lifecycle' });
let serviceBrand: ((value: unknown) => boolean) | null = null;
const associations = new WeakMap<object, PracticalCancelLifecycle>();

/** Defining service module static initialization only, once. */
export function installPracticalCancelLifecycleBrand(reader: (value: unknown) => boolean): void {
  if (serviceBrand !== null) throw new Error('CANCEL_LIFECYCLE_BRAND_ALREADY_INSTALLED');
  serviceBrand = reader;
}

export class PracticalCancelLifecycle {
  readonly #owner: object;
  readonly #dependencies: object;
  #closed = false;

  public constructor(issuer: unknown, owner: object, dependencies: object) {
    if (issuer !== ISSUER) throw new Error('CANCEL_LIFECYCLE_ISSUER_REFUSED');
    this.#owner = owner;
    this.#dependencies = dependencies;
    Object.freeze(this);
  }

  public static matches(value: unknown, owner: unknown, dependencies: unknown): value is PracticalCancelLifecycle {
    return typeof value === 'object' && value !== null && #owner in value
      && value.#owner === owner && value.#dependencies === dependencies
      && associations.get(value.#owner) === value;
  }

  public static open(value: unknown, owner: unknown, dependencies: unknown): boolean {
    return this.matches(value, owner, dependencies) && !value.#closed;
  }

  public static close(value: unknown, owner: unknown, dependencies: unknown): void {
    if (!this.matches(value, owner, dependencies)) throw new Error('CANCEL_LIFECYCLE_ASSOCIATION_REFUSED');
    value.#closed = true;
  }

  public toJSON(): never { throw new Error('CANCEL_LIFECYCLE_NOT_SERIALIZABLE'); }
}

/** Only a genuine service constructs its one association; duplicate creation refuses. */
export function createPracticalCancelLifecycle(owner: object, dependencies: object): PracticalCancelLifecycle {
  if (serviceBrand === null || !serviceBrand(owner) || associations.has(owner)) throw new Error('CANCEL_LIFECYCLE_OWNER_REFUSED');
  const association = new PracticalCancelLifecycle(ISSUER, owner, dependencies);
  associations.set(owner, association);
  return association;
}

Object.freeze(PracticalCancelLifecycle.prototype);
Object.freeze(PracticalCancelLifecycle);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ PracticalCancelLifecycle, installPracticalCancelLifecycleBrand, createPracticalCancelLifecycle })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined || module.exports[name] !== value) throw new Error('CANCEL_LIFECYCLE_EXPORT_BINDING_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
