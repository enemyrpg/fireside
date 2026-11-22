import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface Column<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Numbers are right-aligned. */
  align?: 'left' | 'right';
  /** Less important: hidden on mobile. */
  minor?: boolean;
  className?: string;
}

export interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string | number;
  /** Accessible name of the table. */
  label: string;
  /**
   * DOM id of a row, for jumping to it. Such a row can take focus from code
   * (it is not a tab stop).
   */
  rowId?: (row: Row) => string;
  /** Extra classes for one row, e.g. a bold total row or dimmed empty rows. */
  rowClassName?: (row: Row) => string | undefined;
  /**
   * Makes the whole row clickable with the mouse. Put a button in a cell for
   * keyboard and screen readers; the row itself is not a tab stop.
   */
  onRowClick?: (row: Row) => void;
  className?: string;
}

/** Table with 36 px rows, right-aligned tabular numbers and row hover. */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  rowId,
  label,
  rowClassName,
  onRowClick,
  className,
}: DataTableProps<Row>) {
  const columnClass = (column: Column<Row>) =>
    cn(
      'px-2.5',
      column.align === 'right' && 'text-right',
      column.minor && 'hidden desk:table-cell',
      column.className,
    );

  return (
    <Table aria-label={label} className={cn('text-table tabular-nums', className)}>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          {columns.map((column) => (
            <TableHead
              key={column.id}
              className={cn('h-auto py-[7px] font-medium text-text-2', columnClass(column))}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            {...(rowId ? { id: rowId(row), tabIndex: -1 } : {})}
            className={cn(
              'border-border hover:bg-hover',
              rowId && 'outline-none',
              onRowClick && 'cursor-pointer',
              rowClassName?.(row),
            )}
            {...(onRowClick
              ? {
                  onClick: () => {
                    onRowClick(row);
                  },
                }
              : {})}
          >
            {columns.map((column) => (
              <TableCell key={column.id} className={cn('h-9 py-0', columnClass(column))}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
