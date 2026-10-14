// A small in-memory stand-in for the part of supabase-js the billing code uses: from(table).insert / upsert / update / select with eq, is, in, lt, lte,
// order, limit, and a thenable result of the shape { data, error }. It follows PostgREST where it matters here: a duplicate primary or unique key is
// error 23505 (on insert, on upsert AND on update), a unique column may be null in many rows, `upsert` only touches the columns it is given,
// `ignoreDuplicates` leaves an existing row alone, a composite `onConflict: "provider,id"` matches on every column, timestamps compare as instants,
// and `update ... select` returns the rows it changed. It does NOT check Row Level Security or types: the SQL has its own check (see BILLING.md).
type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { code?: string; message: string } | null };

interface TableSpec {
  primaryKey: string | string[];
  unique?: string[];
}

const columnsOf = (key: string | string[]): string[] => (Array.isArray(key) ? key : key.split(",").map((column) => column.trim()));

/** Compares two column values the way Postgres would for the types used here: instants for timestamps, strings otherwise. */
function compare(a: unknown, b: unknown): number {
  const isTime = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]/.test(value);
  if (isTime(a) && isTime(b)) return Date.parse(String(a)) - Date.parse(String(b));
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  specs: Record<string, TableSpec>;
  /** Every statement that ran, for tests that care about how many round trips happened. */
  log: string[] = [];
  /** When set, a row with a `user_id` that is not in here is refused like the foreign key to auth.users does (23503). */
  users: Set<string> | null = null;

  constructor(specs: Record<string, TableSpec>) {
    this.specs = specs;
    for (const name of Object.keys(specs)) this.tables[name] = [];
  }

  from(table: string) {
    if (!this.specs[table]) throw new Error(`unknown table ${table}`);
    return new Query(this, table);
  }
}

const DUPLICATE = (table: string) => ({ code: "23505", message: `duplicate key value violates unique constraint on ${table}` });
const NO_USER = (table: string) => ({ code: "23503", message: `insert or update on table "${table}" violates foreign key constraint to auth.users` });

class Query {
  private op: "select" | "insert" | "upsert" | "update" = "select";
  private payload: Row = {};
  private options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private filters: ((row: Row) => boolean)[] = [];
  private returning = false;
  private columns: string[] | null = null;
  private max = Infinity;
  private sort: { column: string; ascending: boolean } | null = null;

  private db: FakeSupabase;
  private table: string;

  constructor(db: FakeSupabase, table: string) {
    this.db = db;
    this.table = table;
  }

  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  upsert(row: Row, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = row;
    this.options = options;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  select(columns?: string) {
    if (this.op !== "select") this.returning = true;
    // Like PostgREST: only the columns that were asked for come back.
    this.columns = columns && columns !== "*" ? columns.split(",").map((column) => column.trim()) : null;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: null | boolean) {
    this.filters.push((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value));
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.sort = { column, ascending: options?.ascending ?? true };
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push((row) => compare(row[column], value) < 0);
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push((row) => compare(row[column], value) <= 0);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }

  then<T>(resolve: (value: Result) => T, reject?: (reason: unknown) => T) {
    try {
      return Promise.resolve(resolve(this.run()));
    } catch (error) {
      return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
    }
  }

  private run(): Result {
    const rows = this.db.tables[this.table];
    const spec = this.db.specs[this.table];
    const primary = columnsOf(spec.primaryKey);
    this.db.log.push(`${this.op} ${this.table}`);
    const matching = () => rows.filter((row) => this.filters.every((f) => f(row)));
    const samePrimary = (a: Row, b: Row, columns = primary) => columns.every((column) => a[column] === b[column]);
    /** The existing row that `candidate` would collide with, other than `except` (primary key, or a unique column that is not null). */
    const clash = (candidate: Row, except?: Row) =>
      rows.find(
        (row) =>
          row !== except &&
          ((primary.every((column) => candidate[column] !== undefined) && samePrimary(row, candidate)) || (spec.unique ?? []).some((column) => candidate[column] != null && row[column] === candidate[column])),
      );

    const project = (row: Row): Row => (this.columns ? Object.fromEntries(this.columns.map((column) => [column, row[column]])) : { ...row });

    if (this.op === "select") {
      const found = matching();
      if (this.sort) {
        const { column, ascending } = this.sort;
        found.sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
      }
      return { data: found.slice(0, this.max).map(project), error: null };
    }

    if ((this.op === "insert" || this.op === "upsert") && this.db.users && typeof this.payload.user_id === "string" && !this.db.users.has(this.payload.user_id)) {
      return { data: null, error: NO_USER(this.table) };
    }

    if (this.op === "insert") {
      if (clash(this.payload)) return { data: null, error: DUPLICATE(this.table) };
      rows.push({ ...this.payload });
      return { data: [], error: null };
    }

    if (this.op === "upsert") {
      const conflictColumns = this.options.onConflict ? columnsOf(this.options.onConflict) : primary;
      const existing = rows.find((row) => samePrimary(row, this.payload, conflictColumns));
      if (existing) {
        if (!this.options.ignoreDuplicates) {
          const other = clash({ ...existing, ...this.payload }, existing);
          if (other) return { data: null, error: DUPLICATE(this.table) };
          Object.assign(existing, this.payload);
        }
      } else {
        if (clash(this.payload)) return { data: null, error: DUPLICATE(this.table) };
        rows.push({ ...this.payload });
      }
      return { data: [], error: null };
    }

    const changed = matching();
    for (const row of changed) {
      if (clash({ ...row, ...this.payload }, row)) return { data: null, error: DUPLICATE(this.table) };
    }
    for (const row of changed) Object.assign(row, this.payload);
    return { data: this.returning ? changed.map(project) : [], error: null };
  }
}

export function billingDb() {
  return new FakeSupabase({
    billing_customers: { primaryKey: "user_id", unique: ["paddle_customer_id"] },
    billing_subscriptions: { primaryKey: ["provider", "id"] },
    billing_transactions: { primaryKey: ["provider", "id"] },
    billing_adjustments: { primaryKey: ["provider", "id"] },
    billing_webhook_events: { primaryKey: ["provider", "event_id"] },
  });
}
