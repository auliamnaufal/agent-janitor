export type FlagType = "boolean" | "string" | "number";

export interface FlagSpec {
  name: string;
  type: FlagType;
  alias?: string;
  /** Allow repeated occurrences (collected into an array). */
  multiple?: boolean;
  description?: string;
}

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean | number | string[]>;
  errors: string[];
}

/**
 * Minimal, dependency-free argv parser. Supports `--flag`, `--flag=value`,
 * `--flag value`, short aliases, and repeated flags.
 */
export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  const byAlias = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.alias) byAlias.set(spec.alias, spec);
  }

  const result: ParsedArgs = {
    command: null,
    positionals: [],
    flags: {},
    errors: [],
  };

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;

    if (token === "--") {
      result.positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--") || (token.startsWith("-") && token.length === 2)) {
      const isLong = token.startsWith("--");
      let name = isLong ? token.slice(2) : token.slice(1);
      let inlineValue: string | undefined;

      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      const spec = isLong ? byName.get(name) : byAlias.get(name);
      if (!spec) {
        result.errors.push(`unknown flag: ${token}`);
        i++;
        continue;
      }

      const key = spec.name;
      if (spec.type === "boolean") {
        if (inlineValue !== undefined) {
          result.flags[key] = inlineValue !== "false" && inlineValue !== "0";
        } else {
          result.flags[key] = true;
        }
      } else {
        let value = inlineValue;
        if (value === undefined) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            value = next;
            i++;
          }
        }
        if (value === undefined) {
          result.errors.push(`flag --${key} requires a value`);
        } else if (spec.type === "number") {
          const num = Number(value);
          if (Number.isNaN(num)) result.errors.push(`flag --${key} expects a number`);
          else result.flags[key] = num;
        } else if (spec.multiple) {
          const existing = result.flags[key];
          if (Array.isArray(existing)) existing.push(value);
          else result.flags[key] = [value];
        } else {
          result.flags[key] = value;
        }
      }
      i++;
      continue;
    }

    if (result.command === null) {
      result.command = token;
    } else {
      result.positionals.push(token);
    }
    i++;
  }

  return result;
}

export function flagBool(args: ParsedArgs, name: string, fallback = false): boolean {
  const v = args.flags[name];
  return typeof v === "boolean" ? v : fallback;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  return typeof v === "number" ? v : undefined;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}
