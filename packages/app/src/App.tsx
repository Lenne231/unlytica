import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import "./App.css";

type FileNodeData = {
  kind: "file";
  fileId: string;
  fileName: string;
  csvText: string;
  resourceName: string;
  createdAt: number;
  onReplace?: (nodeId: string, file: File) => Promise<void>;
  onCreateTable?: (fileNodeId: string) => void;
  onRemove?: (nodeId: string) => void;
};

type TableNodeData = {
  kind: "table";
  tableId: string;
  tableName: string;
  sourceFileId: string;
  dbTableName: string;
  query: string;
  isPreviewLoading?: boolean;
  onShowRows?: (nodeId: string) => Promise<void>;
  onRemove?: (nodeId: string) => void;
};

type FlowNode = Node<Record<string, unknown>>;
type FlowEdge = Edge;

type ToastType = "success" | "error" | "info";

type Toast = {
  id: number;
  message: string;
  type: ToastType;
};

type TablePreview = {
  tableNodeId: string;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

const FLOW_STORAGE_KEY = "unlytica-flow-graph";
const FLOW_DB_NAME = "unlytica-flow-db";
const FLOW_DB_STORE = "graph";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbInitPromise: Promise<void> | null = null;

function openGraphStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }

    const request = window.indexedDB.open(FLOW_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FLOW_DB_STORE)) {
        database.createObjectStore(FLOW_DB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open graph store."));
  });
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

function buildNodeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function stripRuntimeData(node: FlowNode): FlowNode {
  const persistedData = { ...(node.data as Record<string, unknown>) };
  delete persistedData.onReplace;
  delete persistedData.onCreateTable;
  delete persistedData.onShowRows;
  delete persistedData.onRemove;
  delete persistedData.isPreviewLoading;

  return {
    ...node,
    data: persistedData,
  };
}

async function loadPersistedFlow() {
  if (typeof window === "undefined") {
    return { nodes: [] as FlowNode[], edges: [] as FlowEdge[] };
  }

  try {
    const db = await openGraphStore();
    const payload = await new Promise<{
      nodes?: FlowNode[];
      edges?: FlowEdge[];
    } | null>((resolve) => {
      const transaction = db.transaction(FLOW_DB_STORE, "readonly");
      const request = transaction
        .objectStore(FLOW_DB_STORE)
        .get(FLOW_STORAGE_KEY);

      request.onsuccess = () =>
        resolve(
          (request.result as
            | { nodes?: FlowNode[]; edges?: FlowEdge[] }
            | undefined) ?? null,
        );
      request.onerror = () => resolve(null);
    });

    if (
      payload &&
      Array.isArray(payload.nodes) &&
      Array.isArray(payload.edges)
    ) {
      return {
        nodes: payload.nodes,
        edges: payload.edges,
      };
    }

    db.close();
  } catch {
    // Fall back to localStorage if IndexedDB is unavailable.
  }

  try {
    const raw = window.localStorage.getItem(FLOW_STORAGE_KEY);
    if (!raw) {
      return { nodes: [] as FlowNode[], edges: [] as FlowEdge[] };
    }

    const parsed = JSON.parse(raw) as {
      nodes?: FlowNode[];
      edges?: FlowEdge[];
    };
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [] as FlowNode[], edges: [] as FlowEdge[] };
  }
}

async function savePersistedFlow(nodes: FlowNode[], edges: FlowEdge[]) {
  if (typeof window === "undefined") {
    return;
  }

  const payload = {
    nodes: nodes.map(stripRuntimeData),
    edges,
  };

  try {
    const db = await openGraphStore();
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(FLOW_DB_STORE, "readwrite");
      const request = transaction
        .objectStore(FLOW_DB_STORE)
        .put(payload, FLOW_STORAGE_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Fall back to localStorage if IndexedDB is unavailable.
  }

  try {
    window.localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota or storage failures so a refreshed app can still render.
  }
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

function createTableQuery(sourceFileResourceName: string) {
  return `SELECT * FROM read_csv_auto('${sourceFileResourceName}', header = true)`;
}

function createSourceResourceName(fileNodeId: string, fileName: string) {
  const safeName = sanitizeTableName(fileName || "uploaded_csv");
  return `${safeName}_${fileNodeId.replace(/[^a-zA-Z0-9_]/g, "_")}.csv`;
}

function buildDerivedTableName(
  sourceFileName: string,
  currentNodes: FlowNode[],
) {
  const baseName = sanitizeTableName(String(sourceFileName || "uploaded_csv"));
  const existingCount = currentNodes.filter((candidate) => {
    const candidateData = candidate.data as Partial<TableNodeData>;
    return candidateData.kind === "table";
  }).length;

  return `${baseName}_table_${existingCount + 1}`;
}

function FileNodeCard({
  data,
  id,
}: {
  data: Record<string, unknown>;
  id: string;
}) {
  const fileData = data as FileNodeData;
  const inputRef = useRef<HTMLInputElement | null>(null);

  if (fileData.kind !== "file") {
    return null;
  }

  return (
    <div className="flow-node file-node">
      <Handle type="source" position={Position.Right} />
      <div className="flow-node-header">
        <span className="flow-node-tag file-tag">File</span>
        <button
          type="button"
          className="node-close-button"
          aria-label={`Remove ${fileData.fileName}`}
          onClick={() => fileData.onRemove?.(id)}
        >
          ×
        </button>
      </div>

      <div className="flow-node-title">{fileData.fileName}</div>
      <div className="flow-node-subtitle">CSV source</div>

      <div className="flow-node-actions">
        <button type="button" onClick={() => inputRef.current?.click()}>
          Replace
        </button>
        <button type="button" onClick={() => fileData.onCreateTable?.(id)}>
          Create table
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) {
            await fileData.onReplace?.(id, file);
          }
          event.target.value = "";
        }}
      />
    </div>
  );
}

function TableNodeCard({
  data,
  id,
}: {
  data: Record<string, unknown>;
  id: string;
}) {
  const tableData = data as TableNodeData;

  if (tableData.kind !== "table") {
    return null;
  }

  return (
    <div className="flow-node table-node">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-tag table-tag">Table</span>
        <button
          type="button"
          className="node-close-button"
          aria-label={`Remove ${tableData.tableName}`}
          onClick={() => tableData.onRemove?.(id)}
        >
          ×
        </button>
      </div>

      <div className="flow-node-title">{tableData.tableName}</div>
      <div className="flow-node-subtitle">Derived table</div>
      <div className="flow-node-actions">
        <button
          type="button"
          onClick={() => void tableData.onShowRows?.(id)}
          disabled={tableData.isPreviewLoading}
        >
          {tableData.isPreviewLoading ? "Loading..." : "Show first 100 rows"}
        </button>
      </div>
      <div className="table-query-preview">{tableData.query}</div>
    </div>
  );
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [status, setStatus] = useState("Canvas ready");
  const [tablePreview, setTablePreview] = useState<TablePreview | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isBooting, setIsBooting] = useState(true);

  const refreshGraph = useCallback(
    async (graphNodes: FlowNode[], graphEdges: FlowEdge[]) => {
      await ensureDb();

      for (const tableNode of graphNodes) {
        const tableData = tableNode.data as Partial<TableNodeData>;
        if (tableData.kind !== "table") {
          continue;
        }

        const sourceNode = graphNodes.find((node) => {
          const fileData = node.data as Partial<FileNodeData>;
          if (fileData.kind !== "file") {
            return false;
          }

          return node.id === tableData.sourceFileId;
        });

        if (!sourceNode) {
          continue;
        }

        const sourceFileData = sourceNode.data as Partial<FileNodeData>;
        if (sourceFileData.kind !== "file") {
          continue;
        }

        const csvResourceName =
          sourceFileData.resourceName ||
          createSourceResourceName(
            sourceNode.id,
            String(sourceFileData.fileName ?? "uploaded_csv"),
          );
        const csvText = String(sourceFileData.csvText ?? "");
        await db!.registerFileText(csvResourceName, csvText);

        await conn!.query(
          `CREATE OR REPLACE TABLE "${String(tableData.dbTableName ?? tableNode.id)}" AS ${String(tableData.query ?? "SELECT 1")};`,
        );
      }

      void savePersistedFlow(graphNodes, graphEdges);
    },
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const nodesRef = useRef<FlowNode[]>(nodes);
  const edgesRef = useRef<FlowEdge[]>(edges);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const setTablePreviewLoading = useCallback(
    (nodeId: string, isPreviewLoading: boolean) => {
      setNodes((currentNodes) =>
        currentNodes.map((candidate) => {
          const candidateData = candidate.data as Partial<TableNodeData>;
          if (candidate.id !== nodeId || candidateData.kind !== "table") {
            return candidate;
          }

          return {
            ...candidate,
            data: {
              ...candidateData,
              isPreviewLoading,
            },
          };
        }),
      );
    },
    [setNodes],
  );

  const showTableRowsPreview = useCallback(
    async (nodeId: string) => {
      const tableNode = nodesRef.current.find(
        (candidate) => candidate.id === nodeId,
      );
      const tableData = tableNode?.data as Partial<TableNodeData> | undefined;
      if (!tableNode || tableData?.kind !== "table") {
        return;
      }

      setTablePreviewLoading(nodeId, true);
      setError(null);

      try {
        await ensureDb();

        const dbTableName = String(tableData.dbTableName ?? "");
        const queryResult = await conn!.query<any>(
          `SELECT * FROM "${dbTableName}" LIMIT 100;`,
        );
        const rows = queryResult.toArray() as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        setTablePreview({
          tableNodeId: nodeId,
          tableName: String(tableData.tableName ?? tableNode.id),
          columns,
          rows,
        });
        setStatus(
          `Showing first ${rows.length} rows from ${String(tableData.tableName ?? tableNode.id)}`,
        );
      } catch (previewError) {
        const message =
          previewError instanceof Error
            ? previewError.message
            : "Failed to load table rows.";
        setError(message);
        setToast({
          id: Date.now(),
          message: "Unable to show table rows.",
          type: "error",
        });
      } finally {
        setTablePreviewLoading(nodeId, false);
      }
    },
    [setTablePreviewLoading],
  );

  const removeNode = useCallback(
    async (nodeId: string) => {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const nodeToDelete = currentNodes.find(
        (candidate) => candidate.id === nodeId,
      );
      if (!nodeToDelete) {
        return;
      }

      const hasDependents = currentEdges.some((edge) => edge.source === nodeId);
      if (hasDependents) {
        setToast({
          id: Date.now(),
          message: "This node still has dependent nodes and cannot be deleted.",
          type: "error",
        });
        setError("Delete blocked: dependent nodes still exist.");
        return;
      }

      const tableData = nodeToDelete.data as Partial<TableNodeData>;

      await ensureDb();
      if (tableData.kind === "table" && tableData.dbTableName && conn) {
        await conn.query(
          `DROP TABLE IF EXISTS "${String(tableData.dbTableName)}";`,
        );
      }

      setNodes((currentNodesState) =>
        currentNodesState.filter((candidate) => candidate.id !== nodeId),
      );
      setEdges((currentEdgesState) =>
        currentEdgesState.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      );
      setTablePreview((currentPreview) => {
        if (!currentPreview || currentPreview.tableNodeId !== nodeId) {
          return currentPreview;
        }

        return null;
      });
      setToast({
        id: Date.now(),
        message: "Node and backing resource removed.",
        type: "success",
      });
      setError(null);
    },
    [setEdges, setNodes],
  );

  const attachRuntimeHandlers = useCallback(
    (node: FlowNode): FlowNode => {
      const nodeData = node.data as Partial<FileNodeData> &
        Partial<TableNodeData>;

      if (nodeData.kind === "file") {
        return {
          ...node,
          data: {
            ...nodeData,
            onCreateTable: (fileNodeId: string) => {
              setNodes((currentNodes) => {
                const sourceNode = currentNodes.find(
                  (candidate) => candidate.id === fileNodeId,
                );
                if (!sourceNode) {
                  return currentNodes;
                }

                const sourceData = sourceNode.data as Partial<FileNodeData>;
                if (sourceData.kind !== "file") {
                  return currentNodes;
                }

                const tableId = buildNodeId("table");
                const tableName = buildDerivedTableName(
                  String(sourceData.fileName ?? "uploaded_csv"),
                  currentNodes,
                );
                const dbTableName = `table_${tableName}_${tableId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
                const csvResourceName =
                  sourceData.resourceName ||
                  createSourceResourceName(
                    sourceNode.id,
                    String(sourceData.fileName ?? "uploaded_csv"),
                  );
                const tableNode: FlowNode = {
                  id: tableId,
                  type: "tableNode",
                  position: {
                    x: sourceNode.position.x + 300,
                    y: sourceNode.position.y + 40,
                  },
                  data: {
                    kind: "table",
                    tableId,
                    tableName,
                    sourceFileId: sourceNode.id,
                    dbTableName,
                    query: createTableQuery(csvResourceName),
                  },
                };

                const nextNodes = [...currentNodes, tableNode];
                const edge: FlowEdge = {
                  id: `edge-${sourceNode.id}-${tableId}`,
                  source: sourceNode.id,
                  target: tableId,
                  markerEnd: { type: MarkerType.ArrowClosed },
                };

                setEdges((currentEdges) => {
                  const nextEdges = [...currentEdges, edge];
                  void refreshGraph(nextNodes, nextEdges);
                  return nextEdges;
                });

                return nextNodes;
              });
            },
            onRemove: (nodeId: string) => {
              void removeNode(nodeId);
            },
            onReplace: async (nodeId: string, file: File) => {
              if (!file.name.toLowerCase().endsWith(".csv")) {
                setError("Please select a CSV file.");
                return;
              }

              const csvText = await file.text();
              setNodes((currentNodes) => {
                const sourceNode = currentNodes.find(
                  (candidate) => candidate.id === nodeId,
                );
                const sourceData = sourceNode?.data as
                  | Partial<FileNodeData>
                  | undefined;
                if (!sourceNode || sourceData?.kind !== "file") {
                  return currentNodes;
                }

                const nextResourceName = createSourceResourceName(
                  nodeId,
                  file.name,
                );

                const updatedNodes = currentNodes.map((candidate) => {
                  const candidateData = candidate.data as Partial<FileNodeData>;
                  if (
                    candidate.id !== nodeId ||
                    candidateData.kind !== "file"
                  ) {
                    return candidate;
                  }

                  return {
                    ...candidate,
                    data: {
                      ...candidateData,
                      fileName: file.name,
                      csvText,
                      resourceName: nextResourceName,
                      createdAt: Date.now(),
                    },
                  };
                });

                const finalNodes = updatedNodes.map((candidate) => {
                  const candidateData =
                    candidate.data as Partial<TableNodeData>;
                  if (
                    candidateData.kind !== "table" ||
                    candidateData.sourceFileId !== nodeId
                  ) {
                    return candidate;
                  }

                  return {
                    ...candidate,
                    data: {
                      ...candidateData,
                      query: createTableQuery(nextResourceName),
                    },
                  };
                });

                setEdges((currentEdges) => {
                  void refreshGraph(finalNodes, currentEdges);
                  return currentEdges;
                });

                return finalNodes;
              });

              setStatus("Updated file");
              setToast({
                id: Date.now(),
                message: `Replaced ${file.name}.`,
                type: "success",
              });
              setError(null);
            },
          } as unknown as FileNodeData,
        };
      }

      return {
        ...node,
        data: {
          ...nodeData,
          onShowRows: async (nodeId: string) => {
            await showTableRowsPreview(nodeId);
          },
          onRemove: (nodeId: string) => {
            void removeNode(nodeId);
          },
        } as unknown as TableNodeData,
      };
    },
    [refreshGraph, removeNode, showTableRowsPreview],
  );

  const addFileNode = useCallback(
    async (file: File, position = { x: 120, y: 100 }) => {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        setError("Please select a CSV file.");
        return;
      }

      const csvText = await file.text();
      const fileId = buildNodeId("file");
      const resourceName = createSourceResourceName(fileId, file.name);
      const nextNode: FlowNode = {
        id: fileId,
        type: "fileNode",
        position,
        data: {
          kind: "file",
          fileId,
          fileName: file.name,
          csvText,
          resourceName,
          createdAt: Date.now(),
        },
      };

      const hydratedNode = attachRuntimeHandlers(nextNode);
      setNodes((currentNodes) => {
        const nextNodes = [...currentNodes, hydratedNode];
        void refreshGraph(nextNodes, edgesRef.current);
        return nextNodes;
      });
      setStatus(`Added ${file.name}`);
      setToast({
        id: Date.now(),
        message: `Added ${file.name} to the canvas.`,
        type: "success",
      });
      setError(null);
    },
    [attachRuntimeHandlers, refreshGraph, setNodes],
  );

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        await ensureDb();
        const persisted = await loadPersistedFlow();
        const hydratedNodes = persisted.nodes.map((node) =>
          attachRuntimeHandlers(node),
        );
        setNodes(hydratedNodes);
        setEdges(persisted.edges);
        setIsHydrated(true);
        setIsBooting(false);
        await refreshGraph(hydratedNodes, persisted.edges);
        setStatus("Canvas ready");
      } catch (bootError) {
        const message =
          bootError instanceof Error
            ? bootError.message
            : "DuckDB failed to initialize.";
        setError(message);
        setStatus("DuckDB failed to initialize.");
        setIsBooting(false);
      }
    };

    void bootstrap();
  }, [attachRuntimeHandlers, refreshGraph, setEdges, setNodes]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    void savePersistedFlow(nodes, edges);
  }, [edges, isHydrated, nodes]);

  const handleFileSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length === 0) {
        event.target.value = "";
        return;
      }

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        await addFileNode(file, {
          x: Math.max(80, (nodesRef.current.length + index) * 30),
          y: Math.max(80, (nodesRef.current.length + index) * 50),
        });
      }

      event.target.value = "";
    },
    [addFileNode],
  );

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) {
        return;
      }

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const position = flowInstance
          ? flowInstance.screenToFlowPosition({
              x: event.clientX + index * 24,
              y: event.clientY + index * 20,
            })
          : { x: 120 + index * 30, y: 80 + index * 30 };

        await addFileNode(file, position);
      }
    },
    [addFileNode, flowInstance],
  );

  const nodeTypes = useMemo(
    () => ({
      fileNode: (props: { data: Record<string, unknown>; id: string }) => (
        <FileNodeCard {...props} />
      ),
      tableNode: (props: { data: Record<string, unknown>; id: string }) => (
        <TableNodeCard {...props} />
      ),
    }),
    [],
  );

  if (isBooting) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="boot-spinner" aria-label="Loading graph" />
          <h1>Loading canvas…</h1>
          <p>Restoring saved nodes and tables.</p>
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

      <div className="app-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Unlytica</p>
            <h1>Flow canvas</h1>
          </div>

          <div className="toolbar-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => fileInputRef.current?.click()}
            >
              Add CSV
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={handleFileSelection}
            />
          </div>
        </header>

        <div className="status-bar">{status}</div>
        {error ? <div className="error-banner">{error}</div> : null}
        {tablePreview ? (
          <div
            className="table-preview-dialog-backdrop"
            role="presentation"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setTablePreview(null);
              }
            }}
          >
            <section
              className="table-preview-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Preview for ${tablePreview.tableName}`}
            >
              <div className="table-preview-header">
                <div>
                  <h2>{tablePreview.tableName}</h2>
                  <p>Showing first {tablePreview.rows.length} rows</p>
                </div>
                <button
                  type="button"
                  className="node-close-button"
                  aria-label="Close table preview"
                  onClick={() => setTablePreview(null)}
                >
                  ×
                </button>
              </div>

              {tablePreview.rows.length === 0 ? (
                <div className="table-preview-empty">
                  No rows found for this table.
                </div>
              ) : (
                <div className="table-preview-scroll">
                  <table>
                    <thead>
                      <tr>
                        {tablePreview.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tablePreview.rows.map((row, rowIndex) => (
                        <tr key={`${tablePreview.tableNodeId}-row-${rowIndex}`}>
                          {tablePreview.columns.map((column) => (
                            <td
                              key={`${tablePreview.tableNodeId}-${rowIndex}-${column}`}
                            >
                              {String(row[column] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        ) : null}

        <div
          className="flow-panel"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onInit={setFlowInstance}
            fitView
            defaultEdgeOptions={{ animated: false }}
          >
            <MiniMap pannable zoomable />
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
          </ReactFlow>

          {nodes.length === 0 ? (
            <div className="canvas-empty-state">
              <div className="canvas-empty-card">
                <h2>Drop a CSV file to start</h2>
                <p>
                  Each file becomes a node in the canvas. Create a derived table
                  node from it to keep DuckDB updates in sync.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

export default App;
