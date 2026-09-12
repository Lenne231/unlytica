import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbInitPromise: Promise<void> | null = null;

export async function ensureDb() {
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

export function getDuckDb() {
  if (!db) {
    throw new Error("DuckDB is not initialized.");
  }

  return db;
}

export function getDuckDbConnection() {
  if (!conn) {
    throw new Error("DuckDB is not initialized.");
  }

  return conn;
}

export async function registerCsvResource(
  resourceName: string,
  csvText: string,
) {
  await ensureDb();
  const duckDb = getDuckDb();
  await duckDb.registerFileText(resourceName, csvText);
}

export async function executeSql(query: string) {
  await ensureDb();
  return getDuckDbConnection().query(query);
}

export async function dropTableIfExists(tableName: string) {
  await ensureDb();
  await getDuckDbConnection().query(`DROP TABLE IF EXISTS "${tableName}";`);
}

export async function getTablePreviewQuery(dbTableName: string) {
  await ensureDb();
  return getDuckDbConnection().query(
    `SELECT * FROM "${dbTableName}" LIMIT 100;`,
  );
}
