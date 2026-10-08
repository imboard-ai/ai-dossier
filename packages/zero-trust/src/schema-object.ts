/** Closed objects require every declared property in both receipt and portable schemas. */
export function object<T extends Record<string, unknown>>(properties: T) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
