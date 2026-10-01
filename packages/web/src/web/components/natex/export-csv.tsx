import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiMessage } from "@/lib/api";
import { collectPages, downloadCsv, type CsvCell } from "@/lib/csv";

/**
 * §11: every list exports to CSV. The export walks the server's pages with the
 * SAME filter the table is showing — so what lands in the file is what the
 * user filtered to, not the page they happen to be on, and not the whole table.
 */
export function ExportCsvButton<T>({
  filename,
  header,
  toRow,
  fetchPage,
  disabled,
}: {
  filename: string;
  header: string[];
  toRow: (row: T) => CsvCell[];
  fetchPage: (page: number) => Promise<{ rows: T[]; total: number; pageSize: number }>;
  disabled?: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {note ? <span className="text-[12px] text-muted-foreground">{note}</span> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        pending={pending}
        disabled={disabled}
        onClick={async () => {
          setPending(true);
          setNote(null);
          try {
            const { rows, truncated, total } = await collectPages(fetchPage);
            downloadCsv(filename, header, rows.map(toRow));
            setNote(
              truncated
                ? `First ${rows.length} of ${total} rows — narrow the filter for the rest.`
                : `${rows.length} row${rows.length === 1 ? "" : "s"} exported.`,
            );
          } catch (error) {
            setNote(apiMessage(error, "The export failed."));
          } finally {
            setPending(false);
          }
        }}
      >
        <Download aria-hidden />
        Export CSV
      </Button>
    </div>
  );
}
