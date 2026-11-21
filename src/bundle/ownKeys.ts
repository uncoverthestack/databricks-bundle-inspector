/**
 * Maps keyed by names from a bundle or its code: variable, widget, parameter and
 * configuration names. A plain `{}` already has keys such as `constructor`, `toString` and
 * `__proto__`, so a name like that read the object's own function, or crashed, instead of
 * reading the bundle's value. These read and build only the map's own keys.
 */

/** The value stored under `key`, never one every object has. */
export function own<T>(record: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return record !== null && record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Whether `key` was stored in the map, not inherited. */
export function hasOwnKey(record: object | null | undefined, key: string): boolean {
  return record !== null && record !== undefined && Object.hasOwn(record, key);
}

/** An empty map with no inherited keys, so writing `__proto__` stores a value like any other name. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
