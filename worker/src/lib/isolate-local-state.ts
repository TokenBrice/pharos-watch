/**
 * Per-isolate mutable state container for Cloudflare Workers.
 * Values persist across requests within the same isolate but reset
 * on deployment or recycle. NOT shared across concurrent isolates.
 */
export class IsolateLocalState<T extends Record<string, unknown>> {
  private _state: T;
  constructor(private readonly _initial: () => T) { this._state = _initial(); }
  get state(): T { return this._state; }
  reset(): void { this._state = this._initial(); }
}
