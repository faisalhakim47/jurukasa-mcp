import { UserConfig } from '@app/data/accounting-repository.js';

export function formatCurrency(amount: string|number, userConfig: UserConfig): string {
  const formatter = new Intl.NumberFormat(userConfig.locale ?? 'en-US', {
    style: 'currency',
    currency: userConfig.currencyCode ?? 'USD',
    minimumFractionDigits: userConfig.currencyDecimalPlaces ?? 2,
    maximumFractionDigits: userConfig.currencyDecimalPlaces ?? 2,
  });
  return `${formatter.format(parseFloat(String(amount)))}`;
}

export type AsciiHierarcy = {
  label: string;
  children?: Array<AsciiHierarcy>;
};

export function renderAsciiHierarchy(node: AsciiHierarcy, prefix: string, isLast: boolean, isRoot: boolean = true): string {
  const lines: string[] = [];
  let connector = '';
  if (isRoot) {
    connector = '';
  } else if (prefix === '' && isLast) {
    connector = '└── ';
  } else {
    connector = isLast ? '└─ ' : '├─ ';
  }
  lines.push(`${prefix}${connector}${node.label}`);

  const newPrefix = prefix + (isLast ? '' : '│  ');
  if (node.children) {
    node.children.forEach((child, index) => {
      const childIsLast = index === node.children!.length - 1;
      lines.push(renderAsciiHierarchy(child, newPrefix, childIsLast, false));
    });
  }

  return lines.join('\n');
}

export function renderAsciiTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return '';

  // Calculate column widths
  const colWidths = headers.map((header, i) => {
    const maxDataWidth = rows.length > 0 ? Math.max(...rows.map(row => row[i]?.length || 0)) : 0;
    return Math.max(header.length, maxDataWidth);
  });

  // Create separator line
  const separator = '+' + colWidths.map(width => '-'.repeat(width + 2)).join('+') + '+';

  // Create header row
  const headerRow = '|' + headers.map((header, i) => ` ${header.padEnd(colWidths[i])} `).join('|') + '|';

  // Create data rows
  const dataRows = rows.map(row =>
    '|' + row.map((cell, i) => ` ${cell.padEnd(colWidths[i])} `).join('|') + '|'
  );

  // Combine all parts
  return [separator, headerRow, separator, ...dataRows, separator].join('\n');
}
