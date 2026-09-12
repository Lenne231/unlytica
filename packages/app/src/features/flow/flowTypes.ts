import type { Edge, Node } from "@xyflow/react";

export type FileNodeData = {
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

export type TableNodeData = {
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

export type FlowNode = Node<Record<string, unknown>>;
export type FlowEdge = Edge;

export type ToastType = "success" | "error" | "info";

export type Toast = {
  id: number;
  message: string;
  type: ToastType;
};

export type TablePreview = {
  tableNodeId: string;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
};
