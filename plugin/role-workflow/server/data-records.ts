/** Data indexing is explicit; SDK capabilities are never dispatched with computed members. */
export function readData<T extends object | string, K extends keyof T>(record: T, key: K): T[K] {
  return Object.getOwnPropertyDescriptor(record, key)?.value as T[K];
}
export function readOptionalData<T extends object | string, K extends keyof T>(record: T | null | undefined, key: K): T[K] | undefined {
  return record == null ? undefined : readData(record, key);
}
export function writeData<T extends object, K extends keyof T>(record: T, key: K, value: T[K]): T[K] {
  Object.assign(record, Object.fromEntries([[key, value]]));
  return value;
}
export function deleteData<T extends object, K extends keyof T>(record: T, key: K): boolean {
  return Reflect.deleteProperty(record, key);
}

/** JSON input lookup never invokes inherited properties or accessor functions. */
export function unknownData(record: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
