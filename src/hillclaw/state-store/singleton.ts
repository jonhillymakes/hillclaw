import type { StateStoreOptions } from "./store.js";
import { HillclawStateStore } from "./store.js";

let _store: HillclawStateStore | null = null;

export function getStateStore(opts?: StateStoreOptions): HillclawStateStore {
  if (!_store) {
    _store = new HillclawStateStore(opts);
  }
  return _store;
}

export function closeStateStore(): void {
  _store?.close();
  _store = null;
}

export function resetStateStoreForTest(): void {
  closeStateStore();
}
