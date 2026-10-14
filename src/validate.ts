import { Ajv, type ValidateFunction } from 'ajv';
import type { JsonSchema } from './catalog.js';

/**
 * Closes every described object: the provider's REST pipe rejects a field its
 * DTO does not declare (`forbidNonWhitelisted`), so the tool schema says the
 * same thing up front. An object without declared properties (a free-form
 * `config`, `credentials` or `metadata`) stays open.
 */
export function closeObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeObjects);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = closeObjects(value);
  if (out.properties && typeof out.properties === 'object' && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Validates arguments against the tool schema BEFORE they reach a transport.
 * REST would refuse a bad body itself, but the Socket.IO gateway and the gRPC
 * server do not validate at the edge — a malformed socket payload fails deep
 * inside the provider with `Cannot read properties of undefined`. Checking
 * here gives every transport REST's answer. Like REST's implicit conversion,
 * a numeric string is accepted (and converted) where a number is declared.
 */
export class ArgumentValidator {
  private readonly ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, coerceTypes: true });
  private readonly compiled = new Map<string, ValidateFunction>();

  check(tool: string, schema: JsonSchema, args: unknown): string | undefined {
    let validate = this.compiled.get(tool);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.compiled.set(tool, validate);
    }
    if (validate(args)) return undefined;
    return (validate.errors ?? [])
      .map((error) => {
        const at = error.instancePath ? error.instancePath.slice(1).replace(/\//g, '.') : '(arguments)';
        if (error.keyword === 'additionalProperties') {
          return `${at}: property ${(error.params as { additionalProperty: string }).additionalProperty} should not exist`;
        }
        return `${at}: ${error.message}`;
      })
      .join(', ');
  }
}
