import type { TablePreview } from "./flowTypes";

export function TablePreviewDialog({
  tablePreview,
  onClose,
}: {
  tablePreview: TablePreview | null;
  onClose: () => void;
}) {
  if (!tablePreview) {
    return null;
  }

  return (
    <div
      className="table-preview-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
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
            onClick={onClose}
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
  );
}
