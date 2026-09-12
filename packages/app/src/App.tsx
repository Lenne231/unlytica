import { useEffect, useState } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import "./App.css";

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
  const [tableName, setTableName] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    ensureDb()
      .then(() => {
        setIsReady(true);
        setStatus("DuckDB is ready. Upload a CSV to import it.");
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
      setColumns([]);
      setTableName(null);

      await ensureDb();

      const tableBaseName = sanitizeTableName(file.name);
      const csvFileName = `${tableBaseName}.csv`;
      const csvText = await file.text();

      await db!.registerFileText(csvFileName, csvText);
      await conn!.query(`DROP TABLE IF EXISTS "${tableBaseName}";`);
      await conn!.query(
        `CREATE TABLE "${tableBaseName}" AS SELECT * FROM read_csv_auto('${csvFileName}', header = true, all_varchar = true);`,
      );

      const describeResult = await conn!.query<any>(
        `DESCRIBE "${tableBaseName}";`,
      );
      const nextColumns = describeResult
        .toArray()
        .map((row: Record<string, unknown>) =>
          String(Object.values(row)[0] ?? ""),
        )
        .filter(Boolean);

      setTableName(tableBaseName);
      setColumns(nextColumns);
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
    }
  }

  return (
    <main className="app-shell">
      <section className="card">
        <h1>DuckDB CSV Import</h1>
        <p>
          Upload a CSV and it will be imported into a DuckDB table using
          read_csv_auto.
        </p>

        <label className="file-picker">
          <span>{isLoading ? "Importing…" : "Choose a CSV file"}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
          />
        </label>

        <p className="status">{status}</p>

        {error ? <p className="error">{error}</p> : null}

        {tableName ? (
          <div className="table-summary">
            <h2>Imported table</h2>
            <p>
              Table name: <strong>{tableName}</strong>
            </p>
            <ul>
              {columns.map((column) => (
                <li key={column}>{column}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default App;
