import { Handle, Position } from "@xyflow/react";
import { useRef } from "react";
import type { FileNodeData, TableNodeData } from "./flowTypes";

export function FileNodeCard({
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

export function TableNodeCard({
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
