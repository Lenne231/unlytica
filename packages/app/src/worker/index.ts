import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

type InitMessage = {
  type: "init";
};

type ImportCsvMessage = {
  type: "import-csv";
  file: File;
  tableName?: string;
};

type ImportSuccessMessage = {
  type: "import-success";
  tableName: string;
  columns: string[];
};

type WorkerReadyMessage = {
  type: "worker-ready";
};

type DebugLogMessage = {
  type: "debug-log";
  message: string;
};

type ImportErrorMessage = {
  type: "import-error";
  message: string;
};

type WorkerMessage =
  | InitMessage
  | ImportCsvMessage
  | ImportSuccessMessage
  | WorkerReadyMessage
  | DebugLogMessage
  | ImportErrorMessage;

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb() {
  if (db && conn) {
    return;
  }

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      self.postMessage({
        type: "debug-log",
        message: "Selecting DuckDB bundle...",
      });
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
      self.postMessage({
        type: "debug-log",
        message: "DuckDB bundle selected.",
      });

      const worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.ConsoleLogger();
      self.postMessage({
        type: "debug-log",
        message: "Instantiating DuckDB WASM...",
      });

      db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      self.postMessage({
        type: "debug-log",
        message: "DuckDB WASM instantiated.",
      });

      conn = await db.connect();
      self.postMessage({
        type: "debug-log",
        message: "DuckDB connection ready.",
      });
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

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const payload = event.data;

  if (payload?.type === "init") {
    self.postMessage({
      type: "debug-log",
      message: "Worker received init message.",
    });
    try {
      await ensureDb();
      self.postMessage({ type: "worker-ready" } satisfies WorkerReadyMessage);
      self.postMessage({
        type: "debug-log",
        message: "Worker ready signal sent.",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "DuckDB failed to initialize.";
      self.postMessage({
        type: "import-error",
        message,
      } satisfies ImportErrorMessage);
      self.postMessage({
        type: "debug-log",
        message: `Initialization failed: ${message}`,
      } satisfies DebugLogMessage);
    }
    return;
  }

  if (payload?.type !== "import-csv") {
    return;
  }

  try {
    if (!payload.file || typeof payload.file.text !== "function") {
      throw new Error("No CSV file was provided.");
    }

    self.postMessage({
      type: "debug-log",
      message: `Preparing to import file: ${payload.file.name}`,
    });

    const fileName = payload.tableName || payload.file.name;
    const tableName = sanitizeTableName(fileName);
    const csvFileName = `${tableName}.csv`;

    await ensureDb();

    const csvText = await payload.file.text();
    self.postMessage({
      type: "debug-log",
      message: `CSV file read; registering as ${csvFileName}`,
    });
    await db!.registerFileText(csvFileName, csvText);

    self.postMessage({
      type: "debug-log",
      message: `Executing DuckDB import for table ${tableName}`,
    });
    await conn!.query(`DROP TABLE IF EXISTS "${tableName}";`);
    await conn!.query(
      `CREATE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${csvFileName}', header = true, all_varchar = true);`,
    );

    const describeResult = await conn!.query<any>(`DESCRIBE "${tableName}";`);
    const columns = describeResult
      .toArray()
      .map((row: Record<string, unknown>) =>
        String(Object.values(row)[0] ?? ""),
      )
      .filter(Boolean);

    self.postMessage({
      type: "import-success",
      tableName,
      columns,
    } satisfies ImportSuccessMessage);
    self.postMessage({
      type: "debug-log",
      message: `Import complete for ${tableName}`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to import CSV.";
    self.postMessage({
      type: "import-error",
      message,
    } satisfies ImportErrorMessage);
    self.postMessage({
      type: "debug-log",
      message: `Import failed: ${message}`,
    } satisfies DebugLogMessage);
  }
};
