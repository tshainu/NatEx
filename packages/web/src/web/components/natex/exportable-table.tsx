import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadCsv } from "@/lib/csv";

/**
 * Native-table counterpart to DataTable's universal export action.
 * It intentionally exports the currently rendered, already scoped rows.
 * Pages with server-side full-result exporters should continue using ExportCsvButton.
 */
export function ExportableTable({
  filename = "natex-table.csv",
  children,
  ...tableProps
}: React.TableHTMLAttributes<HTMLTableElement> & {
  filename?: string;
}) {
  const tableRef = React.useRef<HTMLTableElement>(null);

  const exportVisibleRows = () => {
    const table = tableRef.current;
    if (!table) return;
    const header = Array.from(table.querySelectorAll("thead th")).map(
      (cell) => cell.textContent?.trim() ?? "",
    );
    const body = Array.from(table.querySelectorAll("tbody tr"))
      .filter((row) => row.querySelectorAll("td").length === header.length)
      .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent?.trim() ?? ""));
    downloadCsv(filename, header, body);
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={exportVisibleRows}
          title="Exports the rows currently visible in this table."
        >
          <Download aria-hidden />
          Export visible CSV
        </Button>
      </div>
      <table ref={tableRef} {...tableProps}>
        {children}
      </table>
    </div>
  );
}
