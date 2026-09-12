import type {
  FlowEdge,
  FlowNode,
  TableNodeData,
  FileNodeData,
} from "./flowTypes";

const FLOW_STORAGE_KEY = "unlytica-flow-graph";
const FLOW_DB_NAME = "unlytica-flow-db";
const FLOW_DB_STORE = "graph";

export function sanitizeTableName(value: string) {
  return (
    value
      .trim()
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^\d+/, "_$&")
      .replace(/^_+|_+$/g, "") || "uploaded_csv"
  );
}

export function buildNodeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function createTableQuery(sourceFileResourceName: string) {
  return `SELECT * FROM read_csv_auto('${sourceFileResourceName}', header = true)`;
}

export function createSourceResourceName(fileNodeId: string, fileName: string) {
  const safeName = sanitizeTableName(fileName || "uploaded_csv");
  return `${safeName}_${fileNodeId.replace(/[^a-zA-Z0-9_]/g, "_")}.csv`;
}

export function buildDerivedTableName(
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

export function stripRuntimeData(node: FlowNode): FlowNode {
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

export function openGraphStore() {
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

export async function loadPersistedFlow() {
  if (typeof window === "undefined") {
    return { nodes: [] as FlowNode[], edges: [] as FlowEdge[] };
  }

  try {
    const database = await openGraphStore();
    const payload = await new Promise<{
      nodes?: FlowNode[];
      edges?: FlowEdge[];
    } | null>((resolve) => {
      const transaction = database.transaction(FLOW_DB_STORE, "readonly");
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

    database.close();
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

export async function savePersistedFlow(nodes: FlowNode[], edges: FlowEdge[]) {
  if (typeof window === "undefined") {
    return;
  }

  const payload = {
    nodes: nodes.map(stripRuntimeData),
    edges,
  };

  try {
    const database = await openGraphStore();
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(FLOW_DB_STORE, "readwrite");
      const request = transaction
        .objectStore(FLOW_DB_STORE)
        .put(payload, FLOW_STORAGE_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    database.close();
  } catch {
    // Fall back to localStorage if IndexedDB is unavailable.
  }

  try {
    window.localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota or storage failures so a refreshed app can still render.
  }
}

export function isFileNode(
  node: FlowNode,
): node is FlowNode & { data: FileNodeData } {
  return (node.data as Partial<FileNodeData>)?.kind === "file";
}

export function isTableNode(
  node: FlowNode,
): node is FlowNode & { data: TableNodeData } {
  return (node.data as Partial<TableNodeData>)?.kind === "table";
}
