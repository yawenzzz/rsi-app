/** Canonical output definition for tools returning a JSON-encoded text result. */

/** Shared result schema and native text projection; callers own JSON encoding and output limits. */
export const jsonTextOutput = {
  schema: { type: 'object' as const, additionalProperties: false as const,
    properties: { result: { type: 'string' as const, required: true as const } } },
  /**
   * Render the encoded result without interpreting its JSON contents.
   * @param _args - Tool arguments, unused by the output projection.
   * @param value - Validated canonical result.
   * @returns one model-visible text block.
   */
  render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }],
}
