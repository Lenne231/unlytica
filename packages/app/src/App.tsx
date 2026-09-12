import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
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
import "./App.css";
import { FileNodeCard, TableNodeCard } from "./features/flow/FlowNodeCards";
import { TablePreviewDialog } from "./features/flow/TablePreviewDialog";
import type {
  FileNodeData,
  FlowEdge,
  FlowNode,
  TableNodeData,
  TablePreview,
  Toast,
} from "./features/flow/flowTypes";
import {
  buildDerivedTableName,
  buildNodeId,
  createSourceResourceName,
  createTableQuery,
  loadPersistedFlow,
  savePersistedFlow,
} from "./features/flow/flowUtils";
import {
  ensureDb,
  executeSql,
  getTablePreviewQuery,
  dropTableIfExists,
  registerCsvResource,
} from "./features/flow/duckdb";

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
        await registerCsvResource(csvResourceName, csvText);

        await executeSql(
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
        const queryResult = await getTablePreviewQuery(dbTableName);
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
      if (tableData.kind === "table" && tableData.dbTableName) {
        await dropTableIfExists(String(tableData.dbTableName));
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
      fileNode: FileNodeCard,
      tableNode: TableNodeCard,
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
        <TablePreviewDialog
          tablePreview={tablePreview}
          onClose={() => setTablePreview(null)}
        />

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
