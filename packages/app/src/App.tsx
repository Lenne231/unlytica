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

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbInitPromise: Promise<void> | null = null;

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

function App() {
  const [status, setStatus] = useState(
    "Preparing DuckDB… this may take a moment on the first run.",
  );
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [query, setQuery] = useState("SELECT * FROM test_table LIMIT 10;");
  const [queryResult, setQueryResult] = useState<QueryResultRow[]>([]);
  const [queryColumns, setQueryColumns] = useState<string[]>([]);

  const refreshTables = async () => {
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
      const describeResult = await conn!.query<any>(`DESCRIBE "${tableName}";`);
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
  };

  useEffect(() => {
    ensureDb()
      .then(async () => {
        setIsReady(true);
        setStatus("DuckDB is ready. Upload a CSV to import it.");
        await refreshTables();
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
      await conn!.query(`DROP TABLE IF EXISTS "${tableBaseName}";`);
      await conn!.query(
        `CREATE TABLE "${tableBaseName}" AS SELECT * FROM read_csv_auto('${csvFileName}', header = true, all_varchar = true);`,
      );

      await refreshTables();
      setStatus(`Imported CSV as table "${tableBaseName}".`);
    } catch (importError) {
      const message =
        importError instanceof Error
          ? importError.message
          : "Failed to import CSV file.";
      setError(message);
      setStatus("Import failed.");
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
      await refreshTables();
    } catch (queryError) {
      const message =
        queryError instanceof Error ? queryError.message : "Query failed.";
      setError(message);
      setStatus("Query failed.");
      setQueryResult([]);
      setQueryColumns([]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
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
          {tables.length === 0 ? (
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
          <span className={isReady ? "ready-indicator" : "pending-indicator"} />
          {status}
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
                    <tr key={`${rowIndex}-${JSON.stringify(row)}`}>
                      {queryColumns.map((column) => (
                        <td key={`${rowIndex}-${column}`}>
                          {row[column] !== null && row[column] !== undefined
                            ? String(row[column])
                            : ""}
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
  );
}

export default App;
