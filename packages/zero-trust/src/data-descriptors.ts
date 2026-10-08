/** Shared lossless data-container inspection; never invoke accessors or toJSON. */
export function dataDescriptors(value: object, allowNullPrototype = false) {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== (array ? Array.prototype : Object.prototype) &&
    !(allowNullPrototype && !array && prototype === null)
  )
    throw new Error('Invalid data shape');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 20000 || keys.some((key) => typeof key !== 'string'))
    throw new Error('Invalid data shape');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys as string[]) {
    const d = descriptors[key];
    if (!('value' in d) || (!(array && key === 'length') && !d.enumerable))
      throw new Error('Invalid data shape');
  }
  if (array) {
    const length = descriptors.length.value as number;
    if (length > 20000 || keys.length !== length + 1) throw new Error('Invalid data shape');
    for (let i = 0; i < length; i++)
      if (!descriptors[String(i)]) throw new Error('Invalid data shape');
  }
  return { array, keys: keys as string[], descriptors };
}
