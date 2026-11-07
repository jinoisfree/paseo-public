/** JSON input lookup never invokes inherited properties or accessor functions. */
export function unknownData(record: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
