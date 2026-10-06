import type { OAuthTokenStoreI } from "./oauth-token-store.js";

const stores = new WeakMap<OAuthTokenStoreI, RevocableTokenStore>();

/** Serializes credential operations and invalidates providers retained by old transports. */
export class RevocableTokenStore {
  private readonly versions = new Map<string, number>();
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly store: OAuthTokenStoreI) {}

  static forStore(store: OAuthTokenStoreI): RevocableTokenStore {
    let scoped = stores.get(store);
    if (!scoped) {
      scoped = new RevocableTokenStore(store);
      stores.set(store, scoped);
    }
    return scoped;
  }

  forServer(serverName: string): OAuthTokenStoreI {
    const version = this.versions.get(serverName) ?? 0;
    const run = <T>(name: string, action: () => Promise<T>): Promise<T> =>
      this.enqueue(serverName, () => {
        if (
          name !== serverName ||
          version !== (this.versions.get(serverName) ?? 0)
        ) {
          throw new Error("OAuth authentication was cleared. Sign in again.");
        }
        return action();
      });
    return {
      loadTokens: (name) => run(name, () => this.store.loadTokens(name)),
      saveTokens: (name, tokens) =>
        run(name, () => this.store.saveTokens(name, tokens)),
      loadCodeVerifier: (name) =>
        run(name, () => this.store.loadCodeVerifier(name)),
      saveCodeVerifier: (name, verifier) =>
        run(name, () => this.store.saveCodeVerifier(name, verifier)),
      loadClientInfo: (name) =>
        run(name, () => this.store.loadClientInfo(name)),
      saveClientInfo: (name, info) =>
        run(name, () => this.store.saveClientInfo(name, info)),
      deleteAll: (name) => run(name, () => this.store.deleteAll(name)),
    };
  }

  revoke(serverName: string): Promise<void> {
    this.versions.set(serverName, (this.versions.get(serverName) ?? 0) + 1);
    return this.enqueue(serverName, () => this.store.deleteAll(serverName));
  }

  private enqueue<T>(serverName: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(serverName) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.operations.set(serverName, operation);
    void operation
      .finally(() => {
        if (this.operations.get(serverName) === operation)
          this.operations.delete(serverName);
      })
      .catch(() => undefined);
    return operation;
  }
}
