import { useEffect, useState } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import "./App.css";

type ColumnInfo = {
  name: string;
  type: string;
};

type TableInfo = {
  name: string;
  columns: ColumnInfo[];
  expanded: boolean;
};

type QueryResultRow = Record<string, unknown>;

type ToastType = "success" | "error" | "info";

type Toast = {
  id: number;
  message: string;
  type: ToastType;
};

type PersistedTable = {
  name: string;
  csvText: string;
};

const TABLE_STORAGE_KEY = "unlytica-uploaded-tables";
const TABLE_UI_STATE_KEY = "unlytica-table-ui-state";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbInitPromise: Promise<void> | null = null;

function normalizePersistedTables(tables: PersistedTable[]): PersistedTable[] {
  const byName = new Map<string, PersistedTable>();

  for (const table of tables) {
    if (!table?.name || !table?.csvText) {
      continue;
    }

    byName.set(table.name, table);
  }

  return Array.from(byName.values());
}

function loadPersistedTables(): PersistedTable[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(TABLE_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as PersistedTable[];
    return Array.isArray(parsed) ? normalizePersistedTables(parsed) : [];
  } catch {
    return [];
  }
}

function savePersistedTables(tables: PersistedTable[]) {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = normalizePersistedTables(tables);
  window.localStorage.setItem(TABLE_STORAGE_KEY, JSON.stringify(normalized));
}

function loadTableUiState(): TableInfo[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(TABLE_UI_STATE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as TableInfo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTableUiState(tables: TableInfo[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(TABLE_UI_STATE_KEY, JSON.stringify(tables));
}

async function ensureDb() {
  if (db && conn) {
    return;
  }

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const bundles: duckdb.DuckDBBundles = {
        mvp: {
          mainModule: duckdbWasm,
          mainWorker: mvpWorker,
        },
        eh: {
          mainModule: duckdbWasmEh,
          mainWorker: ehWorker,
        },
      };

      const bundle = await duckdb.selectBundle(bundles);
      const worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.ConsoleLogger();

      db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      conn = await db.connect();
    })();
  }

  await dbInitPromise;
}

function sanitizeTableName(value: string) {
  return (
    value
      .trim()
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^\d+/, "_$&")
      .replace(/^_+|_+$/g, "") || "uploaded_csv"
  );
}

function serializeCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as {
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
      BYTES_PER_ELEMENT?: number;
    };
    const bytesPerElement = view.BYTES_PER_ELEMENT ?? 1;
    const array = new Uint8Array(
      view.buffer,
      view.byteOffset,
      view.byteLength / bytesPerElement,
    );
    return Array.from(array).join(", ");
  }

  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value)).join(", ");
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeCellValue(item)).join(", ");
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value, (_key, nestedValue) => {
        if (typeof nestedValue === "bigint") {
          return nestedValue.toString();
        }

        if (nestedValue instanceof Date) {
          return nestedValue.toISOString();
        }

        if (ArrayBuffer.isView(nestedValue)) {
          const view = nestedValue as {
            buffer: ArrayBuffer;
            byteOffset: number;
            byteLength: number;
            BYTES_PER_ELEMENT?: number;
          };
          const bytesPerElement = view.BYTES_PER_ELEMENT ?? 1;
          return Array.from(
            new Uint8Array(
              view.buffer,
              view.byteOffset,
              view.byteLength / bytesPerElement,
            ),
          );
        }

        if (nestedValue instanceof ArrayBuffer) {
          return Array.from(new Uint8Array(nestedValue));
        }

        return nestedValue;
      });
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function App() {
  const [status, setStatus] = useState("");
  const [tables, setTables] = useState<TableInfo[]>(() => loadTableUiState());
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [query, setQuery] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResultRow[]>([]);
  const [queryColumns, setQueryColumns] = useState<string[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    saveTableUiState(tables);
  }, [tables]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toast]);

  function showToast(message: string, type: ToastType = "success") {
    setToast({
      id: Date.now() + Math.random(),
      message,
      type,
    });
  }

  const refreshTables = async () => {
    setTablesLoading(true);

    try {
      await ensureDb();
      const result = await conn!.query<any>("SHOW TABLES;");
      const names = result
        .toArray()
        .map((row) => String(Object.values(row)[0] ?? ""));

      const previousExpanded = new Map(
        tables.map((table) => [table.name, table.expanded]),
      );
      const tableInfos: TableInfo[] = [];

      for (const tableName of names) {
        const describeResult = await conn!.query<any>(
          `DESCRIBE "${tableName}";`,
        );
        const columns = describeResult
          .toArray()
          .map((row: Record<string, unknown>) => ({
            name: String(row.column_name ?? row["column_name"] ?? ""),
            type: String(row.column_type ?? row["column_type"] ?? "unknown"),
          }))
          .filter((column) => column.name);

        tableInfos.push({
          name: tableName,
          columns,
          expanded: previousExpanded.get(tableName) ?? false,
        });
      }

      setTables(tableInfos);

      if (!query && tableInfos.length > 0) {
        setQuery(`SELECT * FROM "${tableInfos[0].name}" LIMIT 10;`);
      }
    } finally {
      setTablesLoading(false);
    }
  };

  useEffect(() => {
    ensureDb()
      .then(async () => {
        setTablesLoading(true);

        try {
          const savedTables = loadPersistedTables();

          for (const savedTable of savedTables) {
            const csvFileName = `${savedTable.name}.csv`;
            await db!.registerFileText(csvFileName, savedTable.csvText);
            await conn!.query(
              `CREATE OR REPLACE TABLE "${savedTable.name}" AS SELECT * FROM read_csv_auto('${csvFileName}', header = true);`,
            );
          }

          setIsReady(true);
          await refreshTables();
        } finally {
          setTablesLoading(false);
        }
      })
      .catch((initError) => {
        setError(
          initError instanceof Error
            ? initError.message
            : "DuckDB could not initialize.",
        );
        setStatus("DuckDB failed to initialize.");
      });
  }, []);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please select a CSV file.");
      return;
    }

    if (!isReady) {
      setError(
        "DuckDB is still initializing. Please wait a moment and try again.",
      );
      return;
    }

    try {
      setError(null);
      setIsLoading(true);
      setStatus(`Importing ${file.name}...`);

      await ensureDb();

      const tableBaseName = sanitizeTableName(file.name);
      const csvFileName = `${tableBaseName}.csv`;
      const csvText = await file.text();

      await db!.registerFileText(csvFileName, csvText);
      await conn!.query(
        `CREATE OR REPLACE TABLE "${tableBaseName}" AS SELECT * FROM read_csv_auto('${csvFileName}', header = true);`,
      );

      const existingTables = loadPersistedTables();
      const nextTables = [
        ...existingTables.filter((table) => table.name !== tableBaseName),
        { name: tableBaseName, csvText },
      ];
      savePersistedTables(nextTables);

      await refreshTables();
      setStatus("Import complete.");
      showToast(`Imported CSV as table "${tableBaseName}".`);
    } catch (importError) {
      const message =
        importError instanceof Error
          ? importError.message
          : "Failed to import CSV file.";
      setError(message);
      setStatus("Import failed.");
      showToast(message, "error");
    } finally {
      setIsLoading(false);
      event.target.value = "";
    }
  }

  function toggleTable(tableName: string) {
    setTables((currentTables) =>
      currentTables.map((table) =>
        table.name === tableName
          ? { ...table, expanded: !table.expanded }
          : table,
      ),
    );
  }

  async function executeQuery() {
    if (!query.trim()) {
      return;
    }

    try {
      setError(null);
      setIsLoading(true);
      setStatus("Executing query...");

      await ensureDb();
      const result = await conn!.query<any>(query);
      const rows = result.toArray();
      const columns = result.schema.fields.map((field) => field.name);

      setQueryResult(rows);
      setQueryColumns(columns);
      setStatus("Query executed successfully.");
      showToast("Query executed successfully.");
      await refreshTables();
    } catch (queryError) {
      const message =
        queryError instanceof Error ? queryError.message : "Query failed.";
      setError(message);
      setStatus("Query failed.");
      showToast(message, "error");
      setQueryResult([]);
      setQueryColumns([]);
    } finally {
      setIsLoading(false);
    }
  }

  if (!isReady) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="boot-spinner" aria-hidden="true" />
          <h1>
            DuckDB is initializing
            <span className="boot-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </h1>
          <p>Preparing DuckDB… this may take a moment on the first run.</p>
          {error ? <p className="error boot-error">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <>
      {toast ? (
        <div
          className={`toast toast-${toast.type}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      ) : null}

      <main className="workspace-shell">
        <aside className="sidebar panel">
          <div className="panel-header">
            <h2>Tables</h2>
          </div>

          <div className="upload-box">
            <label className="file-picker">
              <span>{isLoading ? "Importing…" : "Upload CSV"}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
              />
            </label>
          </div>

          <div className="table-list">
            {tablesLoading ? (
              <p className="empty-state">Loading tables...</p>
            ) : tables.length === 0 ? (
              <p className="empty-state">No tables imported yet.</p>
            ) : (
              tables.map((table) => (
                <div key={table.name} className="table-item">
                  <button
                    type="button"
                    className="table-toggle"
                    onClick={() => toggleTable(table.name)}
                  >
                    <span>{table.expanded ? "▾" : "▸"}</span>
                    <span>{table.name}</span>
                  </button>

                  {table.expanded ? (
                    <ul className="column-list">
                      {table.columns.map((column) => (
                        <li key={`${table.name}-${column.name}`}>
                          <span className="column-name">{column.name}</span>
                          <span className="column-type">{column.type}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="main-panel panel">
          <div className="panel-header">
            <h2>Query</h2>
            <button
              type="button"
              className="run-button"
              onClick={executeQuery}
              disabled={isLoading || !isReady}
            >
              {isLoading ? "Running..." : "Run query"}
            </button>
          </div>

          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="query-editor"
            placeholder="SELECT * FROM my_table;"
          />

          <div className="status-bar">
            {isLoading ||
            status.startsWith("Importing") ||
            status.startsWith("Executing") ||
            status.startsWith("Loading") ? (
              <span className="pending-indicator" />
            ) : null}
            {status === "Ready" ||
            status === "Import complete." ||
            status === "Query executed successfully."
              ? ""
              : status}
          </div>

          {error ? <p className="error">{error}</p> : null}

          <div className="results-panel">
            <h3>Results</h3>

            {queryResult.length === 0 ? (
              <p className="empty-state">No rows returned yet.</p>
            ) : (
              <div className="table-results-wrapper">
                <table className="result-table">
                  <thead>
                    <tr>
                      {queryColumns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryResult.map((row, rowIndex) => (
                      <tr key={`row-${rowIndex}`}>
                        {queryColumns.map((column) => (
                          <td key={`${rowIndex}-${column}`}>
                            {serializeCellValue(row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}

export default App;
