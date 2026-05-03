// Heuristic read-only check. The load-bearing protection is using a DB user
// with only SELECT grants — this parser is a belt-and-suspenders second layer.

const ALLOWED_LEADERS = new Set(["SELECT", "WITH", "EXPLAIN"]);

const DANGEROUS_TOKENS = [
  /\bxp_cmdshell\b/i,
  /\bopenrowset\b/i,
  /\bopenquery\b/i,
  /\bopendatasource\b/i,
  /\bbulk\s+insert\b/i,
  // SELECT ... INTO new_table  → creates a table; block.
  // We deliberately allow `INTO @var` (table variables) is rare in agent flows; err on safe side.
  /\binto\s+(?!#?#?\w*\s*\(\s*select)/i,
];

const stripComments = (sql: string): string => {
  // Remove block comments /* ... */
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove line comments -- ...
  out = out.replace(/--[^\n\r]*/g, " ");
  return out;
};

export class ReadOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolationError";
  }
}

export const assertReadOnly = (rawSql: string): void => {
  const stripped = stripComments(rawSql).trim();
  if (stripped.length === 0) {
    throw new ReadOnlyViolationError("Empty SQL statement.");
  }

  // Reject batches: more than one non-empty statement separated by ;
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length > 1) {
    throw new ReadOnlyViolationError(
      "Read-only mode: multi-statement batches are not allowed. Submit one SELECT at a time.",
    );
  }

  const statement = statements[0]!;
  const leader = statement.match(/^\s*([A-Za-z_]+)/)?.[1]?.toUpperCase();
  if (!leader || !ALLOWED_LEADERS.has(leader)) {
    throw new ReadOnlyViolationError(
      `Read-only mode: only SELECT/WITH/EXPLAIN statements are allowed (got: ${leader ?? "unknown"}).`,
    );
  }

  for (const re of DANGEROUS_TOKENS) {
    if (re.test(statement)) {
      throw new ReadOnlyViolationError(
        `Read-only mode: statement contains a disallowed construct matching ${re}.`,
      );
    }
  }
};
