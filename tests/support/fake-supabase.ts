// A small in-memory stand-in for the part of supabase-js the billing code uses: from(table).insert / upsert / update / select with eq, lt, lte,
// limit, and a thenable result of the shape { data, error }. It follows PostgREST where it matters here: a duplicate primary or unique key is
// error 23505, `upsert` only touches the columns it is given, `ignoreDuplicates` leaves an existing row alone, and `update ... select` returns
// the rows it changed. It does NOT check Row Level Security or types; the SQL has its own review.
type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { code?: string; message: string } | null };

interface TableSpec {
  primaryKey: string;
  unique?: string[];
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  specs: Record<string, TableSpec>;
  /** Every statement that ran, for tests that care about how many round trips happened. */
  log: string[] = [];

  constructor(specs: Record<string, TableSpec>) {
    this.specs = specs;
    for (const name of Object.keys(specs)) this.tables[name] = [];
  }

  from(table: string) {
    if (!this.specs[table]) throw new Error(`unknown table ${table}`);
    return new Query(this, table);
  }
}

class Query {
  private op: "select" | "insert" | "upsert" | "update" = "select";
  private payload: Row = {};
  private options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private filters: ((row: Row) => boolean)[] = [];
  private returning = false;
  private columns: string[] | null = null;
  private max = Infinity;

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
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  order(_column: string, _options?: unknown) {
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push((row) => String(row[column]) < String(value));
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column]) <= String(value));
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
    this.db.log.push(`${this.op} ${this.table}`);
    const matching = () => rows.filter((row) => this.filters.every((f) => f(row)));
    const clash = (candidate: Row) =>
      rows.find((row) => row[spec.primaryKey] === candidate[spec.primaryKey] || (spec.unique ?? []).some((column) => candidate[column] !== undefined && row[column] === candidate[column]));

    const project = (row: Row): Row => (this.columns ? Object.fromEntries(this.columns.map((column) => [column, row[column]])) : { ...row });

    if (this.op === "select") return { data: matching().slice(0, this.max).map(project), error: null };

    if (this.op === "insert") {
      if (clash(this.payload)) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${this.table}` } };
      rows.push({ ...this.payload });
      return { data: [], error: null };
    }

    if (this.op === "upsert") {
      const existing = rows.find((row) => row[this.options.onConflict ?? spec.primaryKey] === this.payload[this.options.onConflict ?? spec.primaryKey]);
      if (existing) {
        if (!this.options.ignoreDuplicates) Object.assign(existing, this.payload);
      } else {
        const other = clash(this.payload);
        if (other) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${this.table}` } };
        rows.push({ ...this.payload });
      }
      return { data: [], error: null };
    }

    const changed = matching();
    for (const row of changed) Object.assign(row, this.payload);
    return { data: this.returning ? changed.map(project) : [], error: null };
  }
}

export function billingDb() {
  return new FakeSupabase({
    billing_customers: { primaryKey: "user_id", unique: ["paddle_customer_id"] },
    billing_subscriptions: { primaryKey: "id" },
    billing_transactions: { primaryKey: "id" },
    billing_adjustments: { primaryKey: "id" },
    billing_webhook_events: { primaryKey: "event_id" },
  });
}
