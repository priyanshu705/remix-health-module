import { ColumnSchema, ColumnDataType } from '../types';
import { parseSheetDate } from './dateUtils';

const CURRENCY_SYMBOLS = ['$', '€', '£', '¥', '₹', 'usd', 'eur', 'gbp', 'inr', 'cad', 'aud'];
const BOOLEAN_VALUES = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 'active', 'inactive', 'pass', 'fail', '0', '1']);

const ENTITY_HEADER_KEYWORDS = [
  'client', 'customer', 'member', 'employee', 'student', 'patient',
  'person', 'athlete', 'user', 'doctor', 'agent', 'naam', 'trainee',
  'representative', 'assignee', 'owner', 'contact', 'lead', 'worker',
  'fullname', 'clientname', 'customername', 'employeename'
];

const IDENTIFIER_HEADER_KEYWORDS = [
  'id', 'orderid', 'order_id', 'invoice', 'invoiceno', 'invoice_id',
  'sku', 'code', 'uuid', 'ref', 'reference', 'accountnumber', 'transid',
  'transactionid', 'ticketid', 'serial', 'rollno', 'roll_no'
];

const DATE_HEADER_KEYWORDS = [
  'date', 'day', 'timestamp', 'time', 'tarikh', 'dt', 'logdate',
  'createdat', 'updatedat', 'entrydate', 'paymentdate', 'attendancedate',
  'joiningdate', 'orderdate', 'shipdate', 'startdate', 'enddate'
];

/**
 * Strips formatting (commas, currency symbols, whitespace) to test for numeric value
 */
function cleanNumericString(val: string): { num: number; hasCurrency: boolean; hasPercentage: boolean; symbol?: string } | null {
  let s = val.trim();
  if (!s) return null;

  let hasCurrency = false;
  let hasPercentage = false;
  let symbol: string | undefined;

  // Percentage check
  if (s.endsWith('%')) {
    hasPercentage = true;
    s = s.slice(0, -1).trim();
  }

  // Currency check
  for (const curr of CURRENCY_SYMBOLS) {
    if (s.toLowerCase().startsWith(curr)) {
      hasCurrency = true;
      symbol = curr;
      s = s.slice(curr.length).trim();
      break;
    } else if (s.toLowerCase().endsWith(curr)) {
      hasCurrency = true;
      symbol = curr;
      s = s.slice(0, -curr.length).trim();
      break;
    }
  }

  // Remove commas used as thousand separators e.g. 1,000.50
  s = s.replace(/,/g, '');

  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (!isNaN(num)) {
      return { num, hasCurrency, hasPercentage, symbol };
    }
  }

  return null;
}

/**
 * Analyzes a dataset's columns dynamically, returning typed schemas, statistics, and detected roles
 */
export function detectColumnSchemas(headers: string[], rows: any[][]): ColumnSchema[] {
  if (!headers || headers.length === 0) return [];

  const schemas: ColumnSchema[] = [];

  for (let c = 0; c < headers.length; c++) {
    const rawHeader = headers[c] || `Column ${c + 1}`;
    const normalized = rawHeader.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Collect all cell values for this column
    const colValues: string[] = [];
    let emptyCount = 0;
    const valueCounts = new Map<string, number>();

    for (let r = 0; r < rows.length; r++) {
      const cell = rows[r]?.[c];
      if (cell === undefined || cell === null) {
        emptyCount++;
        continue;
      }
      const strVal = String(cell).trim();
      if (!strVal) {
        emptyCount++;
        continue;
      }
      colValues.push(strVal);
      valueCounts.set(strVal, (valueCounts.get(strVal) || 0) + 1);
    }

    const sampleValues = colValues.slice(0, 5);
    const uniqueCount = valueCounts.size;

    // Type detection scoring counters
    let numericHits = 0;
    let currencyHits = 0;
    let percentageHits = 0;
    let dateHits = 0;
    let booleanHits = 0;
    let detectedCurrencySymbol: string | undefined;

    const numericValues: number[] = [];

    for (const val of colValues) {
      // 1. Test Date
      const parsedDate = parseSheetDate(val);
      if (parsedDate) {
        dateHits++;
      }

      // 2. Test Number / Currency / Percentage
      const numRes = cleanNumericString(val);
      if (numRes) {
        numericHits++;
        numericValues.push(numRes.num);
        if (numRes.hasCurrency) {
          currencyHits++;
          if (numRes.symbol) detectedCurrencySymbol = numRes.symbol;
        }
        if (numRes.hasPercentage) {
          percentageHits++;
        }
      }

      // 3. Test Boolean
      if (BOOLEAN_VALUES.has(val.toLowerCase())) {
        booleanHits++;
      }
    }

    const totalFilled = colValues.length;
    let dataType: ColumnDataType = 'unknown';
    let detectedTypeLabel = 'Text';

    const isHeaderDateKeyword = DATE_HEADER_KEYWORDS.some(kw => normalized.includes(kw));
    const isHeaderEntityKeyword = ENTITY_HEADER_KEYWORDS.some(kw => normalized.includes(kw) || normalized === kw);
    const isHeaderIdKeyword = IDENTIFIER_HEADER_KEYWORDS.some(kw => normalized.includes(kw));

    if (totalFilled === 0) {
      dataType = 'text';
      detectedTypeLabel = 'Empty';
    } else if (dateHits / totalFilled >= 0.6 || (isHeaderDateKeyword && dateHits > 0)) {
      dataType = 'date';
      detectedTypeLabel = 'Date';
    } else if (currencyHits / totalFilled >= 0.4 || (normalized.includes('price') || normalized.includes('amount') || normalized.includes('revenue') || normalized.includes('cost') || normalized.includes('fee')) && numericHits / totalFilled >= 0.7) {
      dataType = 'currency';
      detectedTypeLabel = 'Currency';
    } else if (percentageHits / totalFilled >= 0.4 || (normalized.includes('pct') || normalized.includes('percent') || normalized.includes('rate')) && numericHits / totalFilled >= 0.7) {
      dataType = 'percentage';
      detectedTypeLabel = 'Percentage';
    } else if (numericHits / totalFilled >= 0.75) {
      dataType = 'numeric';
      detectedTypeLabel = 'Numeric';
    } else if (booleanHits / totalFilled >= 0.85) {
      dataType = 'boolean';
      detectedTypeLabel = 'Boolean';
    } else if (isHeaderEntityKeyword) {
      dataType = 'entity';
      detectedTypeLabel = 'Entity / Person';
    } else if (isHeaderIdKeyword) {
      dataType = 'identifier';
      detectedTypeLabel = 'ID / Reference';
    } else if (uniqueCount <= 12 && totalFilled >= 8) {
      dataType = 'categorical';
      detectedTypeLabel = 'Category / Status';
    } else {
      dataType = 'text';
      detectedTypeLabel = 'Text';
    }

    // Compute numeric summary stats if applicable
    let min: number | undefined;
    let max: number | undefined;
    let avg: number | undefined;
    let sum: number | undefined;

    if (numericValues.length > 0 && (dataType === 'numeric' || dataType === 'currency' || dataType === 'percentage')) {
      sum = numericValues.reduce((acc, v) => acc + v, 0);
      min = Math.min(...numericValues);
      max = Math.max(...numericValues);
      avg = Math.round((sum / numericValues.length) * 100) / 100;
      sum = Math.round(sum * 100) / 100;
    }

    // Top categories distribution
    const topCategories: Array<{ label: string; count: number }> = [];
    if (dataType === 'categorical' || uniqueCount <= 8) {
      const sortedEntries = Array.from(valueCounts.entries()).sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < Math.min(6, sortedEntries.length); i++) {
        topCategories.push({ label: sortedEntries[i][0], count: sortedEntries[i][1] });
      }
    }

    const isEntity = dataType === 'entity' || isHeaderEntityKeyword;
    const isDate = dataType === 'date';
    const isNumeric = dataType === 'numeric' || dataType === 'currency' || dataType === 'percentage';

    schemas.push({
      field: rawHeader,
      normalizedField: normalized,
      columnIndex: c,
      dataType,
      detectedTypeLabel,
      isEntity,
      isDate,
      isNumeric,
      currencySymbol: detectedCurrencySymbol,
      stats: {
        min,
        max,
        avg,
        sum,
        uniqueCount,
        emptyCount,
        sampleValues,
        topCategories: topCategories.length > 0 ? topCategories : undefined
      }
    });
  }

  return schemas;
}
