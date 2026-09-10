import { DailyHealthRecord, SheetParseResult, SheetTabInfo } from '../types';
import { parseSheetDate, formatToYmd } from './dateUtils';
import { detectColumnSchemas } from './schemaDetector';
import { classifyWorksheet } from './dataClassifier';

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
}

export interface GoogleSheetMetadataResponse {
  spreadsheetId: string;
  properties: {
    title: string;
  };
  sheets: Array<{
    properties: {
      sheetId: number;
      title: string;
      index?: number;
      gridProperties?: {
        rowCount: number;
        columnCount: number;
      };
    };
  }>;
}

/**
 * Extracts a Google Spreadsheet ID from either a full Google Sheets URL or a raw ID string.
 */
export function extractSpreadsheetId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  
  // Check if it's already a bare ID (alphanumeric, dashes, underscores, usually 25-60 chars)
  if (/^[a-zA-Z0-9_-]{25,}$/.test(trimmed)) {
    return trimmed;
  }
  
  // Standard Sheets URL format: /spreadsheets/d/([a-zA-Z0-9_-]+)
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  
  // Published sheets URL format: /spreadsheets/d/e/([a-zA-Z0-9_-]+)/pubhtml
  const pubMatch = trimmed.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/);
  if (pubMatch && pubMatch[1]) {
    return pubMatch[1];
  }
  
  return null;
}

/**
 * Searches user's Google Drive for Google Spreadsheets.
 * If query is provided, searches by name.
 * If query is empty, returns recent spreadsheets ordered by modifiedTime desc.
 */
export async function searchSheetsByName(
  accessToken: string, 
  query?: string
): Promise<GoogleDriveFile[]> {
  try {
    let qClause = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
    if (query && query.trim()) {
      const sanitized = query.trim().replace(/'/g, "\\'");
      qClause = `name contains '${sanitized}' and ${qClause}`;
    }

    const qParam = encodeURIComponent(qClause);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${qParam}&fields=files(id,name,mimeType,modifiedTime)&pageSize=40&orderBy=modifiedTime desc`, 
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Drive search failed with status ${res.status}`);
    }

    const data = await res.json();
    return data.files || [];
  } catch (err: any) {
    console.error('Drive search error:', err);
    throw err;
  }
}

/**
 * Fetches spreadsheet metadata including all sheet tabs
 */
export async function getSpreadsheetDetails(
  accessToken: string, 
  spreadsheetId: string
): Promise<GoogleSheetMetadataResponse> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title,sheets.properties`, 
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error?.message || `Failed to fetch sheet details (${res.status})`);
  }

  return await res.json();
}

/**
 * Fetches cell data from a specific sheet range
 */
export async function fetchSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string = 'A1:ZZ1000'
): Promise<any[][]> {
  const encodedRange = encodeURIComponent(range);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?valueRenderOption=FORMATTED_VALUE`, 
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error?.message || `Failed to fetch cell values (${res.status})`);
  }

  const data = await res.json();
  return data.values || [];
}

/**
 * Batch fetches values for multiple ranges in a single Google Sheets API call
 */
export async function fetchBatchSheetValues(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[]
): Promise<Record<string, any[][]>> {
  if (ranges.length === 0) return {};

  const queryParams = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${queryParams}&valueRenderOption=FORMATTED_VALUE`, 
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error?.message || `Failed to batch fetch cell values (${res.status})`);
  }

  const data = await res.json();
  const map: Record<string, any[][]> = {};
  if (data.valueRanges && Array.isArray(data.valueRanges)) {
    data.valueRanges.forEach((vr: any, idx: number) => {
      const requestedRange = ranges[idx];
      map[requestedRange] = vr.values || [];
    });
  }
  return map;
}

/**
 * Discovers and fetches ALL worksheet tabs from ANY connected Google Spreadsheet.
 * Dynamically parses each tab's schema independently and returns tab-agnostic SheetTabInfo[].
 */
export async function fetchAllSpreadsheetTabs(
  accessToken: string,
  spreadsheetId: string
): Promise<{ title: string; tabs: SheetTabInfo[] }> {
  const details = await getSpreadsheetDetails(accessToken, spreadsheetId);
  const spreadsheetTitle = details.properties?.title || 'Google Sheet';
  const sheets = details.sheets || [];

  if (sheets.length === 0) {
    return {
      title: spreadsheetTitle,
      tabs: []
    };
  }

  // Prepare ranges for all worksheets (escaped)
  const ranges = sheets.map(s => `'${s.properties.title.replace(/'/g, "''")}'!A1:ZZ500`);
  let batchData: Record<string, any[][]> = {};

  try {
    batchData = await fetchBatchSheetValues(accessToken, spreadsheetId, ranges);
  } catch (batchErr) {
    console.warn('Batch get failed, falling back to individual fetch:', batchErr);
    for (let i = 0; i < sheets.length; i++) {
      const title = sheets[i].properties.title;
      try {
        const rows = await fetchSheetValues(accessToken, spreadsheetId, `'${title}'!A1:ZZ500`);
        batchData[ranges[i]] = rows;
      } catch (err) {
        console.warn(`Failed to fetch tab "${title}":`, err);
        batchData[ranges[i]] = [];
      }
    }
  }

  const tabs: SheetTabInfo[] = sheets.map((s, idx) => {
    const title = s.properties.title;
    const sheetId = s.properties.sheetId;
    const rows = batchData[ranges[idx]] || [];
    return parseSheetTab(rows, title, sheetId, idx);
  });

  return {
    title: spreadsheetTitle,
    tabs
  };
}

/**
 * Helper to transpose a 2D matrix (convert rows into columns and vice-versa)
 */
function transposeMatrix(matrix: any[][]): any[][] {
  if (!matrix || matrix.length === 0) return [];
  const maxCols = Math.max(...matrix.map(row => (row ? row.length : 0)));
  const transposed: any[][] = [];

  for (let c = 0; c < maxCols; c++) {
    const newRow: any[] = [];
    for (let r = 0; r < matrix.length; r++) {
      const val = matrix[r] && matrix[r][c] !== undefined ? matrix[r][c] : '';
      newRow.push(val);
    }
    transposed.push(newRow);
  }
  return transposed;
}

/**
 * Evaluates whether a cell value looks like a numeric metric value or blood pressure
 */
function isNumericCell(val: any): boolean {
  if (val === undefined || val === null) return false;
  const s = String(val).trim();
  if (!s) return false;
  return /^-?\d+(\.\d+)?$/.test(s) || /^\d{2,3}\/\d{2,3}$/.test(s);
}

const COMMON_HEADER_KEYWORDS = [
  'date', 'day', 'time', 'timestamp', 'name', 'client', 'customer', 'member',
  'user', 'employee', 'id', 'weight', 'steps', 'sleep', 'rate', 'heart',
  'bp', 'status', 'notes', 'amount', 'price', 'total', 'count', 'category',
  'type', 'qty', 'quantity', 'task', 'priority', 'score'
];

/**
 * Parses raw 2D row data for ANY tab into a structured SheetTabInfo object.
 * Tab-agnostic and schema-driven:
 * 1. Automatically locates the best header row (bypassing banners or logos)
 * 2. Transposes vertical/horizontal orientations when detected
 * 3. Infers typed schemas across all detected columns
 * 4. Classifies the worksheet archetype dynamically
 * 5. Extracts normalized records and raw values without fabricating fake data
 */
export function parseSheetTab(
  initialRows: any[][],
  tabTitle: string,
  sheetId: number = 0,
  index: number = 0
): SheetTabInfo {
  if (!initialRows || initialRows.length === 0) {
    return {
      sheetId,
      title: tabTitle,
      index,
      rowCount: 0,
      columnCount: 0,
      headers: [],
      records: [],
      schema: [],
      detectedArchetype: 'GENERIC_DATA',
      archetypeLabel: 'Universal Data',
      archetypeConfidence: 0,
      hasHealthMetrics: false,
      hasClientColumn: false,
      clients: [],
      hasDateColumn: false,
      dates: [],
      isEmpty: true,
      lastUpdated: Date.now()
    };
  }

  let rows = initialRows;

  // 1. TRANSPOSE CHECK: Detect if parameters are listed down Column 0 with dates/records as columns
  if (rows.length >= 3) {
    const col0Cells = rows.slice(0, 15).map(r => String(r[0] || '').toLowerCase().trim());
    const col0Hits = col0Cells.filter(cell => 
      COMMON_HEADER_KEYWORDS.some(kw => cell.includes(kw))
    ).length;

    // Check if row 0 has dates
    const row0DateHits = (rows[0] || []).slice(1, 10).filter(c => parseSheetDate(c) !== null).length;

    if (col0Hits >= 3 || (col0Hits >= 2 && row0DateHits >= 2)) {
      rows = transposeMatrix(rows);
    }
  }

  // 2. HEADER ROW SCORING:
  // Evaluates text labels, keyword hits, non-empty ratio, penalizing single-cell title banners and data rows.
  let headerIndex = 0;
  let bestHeaderScore = -999;
  const maxScanRows = Math.min(rows.length, 15);

  for (let r = 0; r < maxScanRows; r++) {
    const row = rows[r] || [];
    let textCount = 0;
    let numericCount = 0;
    let keywordHits = 0;
    let dateCount = 0;

    row.forEach(cell => {
      if (cell === undefined || cell === null) return;
      const str = String(cell).trim().toLowerCase();
      if (!str) return;

      if (isNumericCell(str)) {
        numericCount++;
      } else if (parseSheetDate(str) !== null) {
        dateCount++;
      } else {
        textCount++;
        if (COMMON_HEADER_KEYWORDS.some(kw => str.includes(kw))) {
          keywordHits++;
        }
      }
    });

    if (textCount === 0 && numericCount === 0 && dateCount === 0) continue;

    // Scoring formula:
    let score = (keywordHits * 15) + (textCount * 4) - (numericCount * 10) - (dateCount * 8);
    
    // Penalty for single-cell title banner e.g. ["Acme Corp Tracking Sheet"]
    if (textCount === 1 && numericCount === 0 && dateCount === 0) {
      score -= 35;
    }
    // Bonus for multi-column header rows (3+ text labels)
    if (textCount >= 3) {
      score += 25;
    }
    // Heavy penalty if this is the last row in rows (likely a data row)
    if (r === rows.length - 1 && rows.length > 1) {
      score -= 50;
    }

    if (score > bestHeaderScore) {
      bestHeaderScore = score;
      headerIndex = r;
    }
  }

  // Fallback if scoring was low: pick first row with >= 2 non-empty cells
  if (bestHeaderScore <= 0) {
    for (let r = 0; r < maxScanRows; r++) {
      const row = rows[r] || [];
      const nonEmpties = row.filter(c => c !== undefined && c !== null && String(c).trim() !== '').length;
      if (nonEmpties >= 2) {
        headerIndex = r;
        break;
      }
    }
  }

  // Extract raw headers
  const rawHeadersRow = rows[headerIndex] || [];
  const headers: string[] = [];
  rawHeadersRow.forEach((cell, idx) => {
    const val = cell !== undefined && cell !== null ? String(cell).trim() : '';
    headers.push(val || `Column ${idx + 1}`);
  });

  // Data rows
  const dataRows = rows.slice(headerIndex + 1).filter(row => 
    row && row.some(cell => cell !== undefined && cell !== null && String(cell).trim() !== '')
  );

  // If the sheet has only headers and no data rows
  if (dataRows.length === 0) {
    const emptySchema = detectColumnSchemas(headers, []);
    const classification = classifyWorksheet(tabTitle, headers, emptySchema);

    return {
      sheetId,
      title: tabTitle,
      index,
      rowCount: 0,
      columnCount: headers.length,
      headers,
      records: [],
      schema: emptySchema,
      detectedArchetype: classification.archetype,
      archetypeLabel: classification.label,
      archetypeConfidence: classification.confidence,
      hasHealthMetrics: classification.archetype === 'HEALTH_VITALITY',
      hasClientColumn: false,
      clients: [],
      hasDateColumn: false,
      dates: [],
      isEmpty: true,
      lastUpdated: Date.now()
    };
  }

  // 3. SCHEMA DETECTION & ARCHETYPE CLASSIFICATION
  const schema = detectColumnSchemas(headers, dataRows);
  const classification = classifyWorksheet(tabTitle, headers, schema);

  // Normalized lowercase header index helper
  const findCol = (keywords: string[]): number => {
    return headers.findIndex(h => {
      const clean = h.toLowerCase().replace(/[^a-z0-9]/g, '');
      return keywords.some(k => clean.includes(k.toLowerCase().replace(/[^a-z0-9]/g, '')));
    });
  };

  // Find entity/client column:
  // First prefer primaryEntityColumn from schema detection, then keyword fallback
  let clientIdx = -1;
  if (classification.primaryEntityColumn) {
    clientIdx = classification.primaryEntityColumn.columnIndex;
  } else {
    clientIdx = findCol([
      'client', 'clientname', 'customer', 'customername', 'member', 'membername',
      'employee', 'employeename', 'patient', 'patientname', 'person', 'personname',
      'athlete', 'user', 'username', 'naam', 'lead', 'contact', 'name'
    ]);
  }

  // Find date column:
  // First prefer primaryDateColumn from schema detection, then keyword fallback
  let dateIdx = -1;
  if (classification.primaryDateColumn) {
    dateIdx = classification.primaryDateColumn.columnIndex;
  } else {
    dateIdx = findCol([
      'date', 'day', 'timestamp', 'logdate', 'entrydate', 'time', 'tarikh', 'dt', 'createdat'
    ]);
  }

  // Find health metric column indexes (if present)
  const stepsIdx = findCol(['steps', 'stepcount', 'step', 'daily_steps']);
  const weightIdx = findCol(['weight', 'wt', 'kg', 'bodyweight', 'lbs']);
  const rhrIdx = findCol(['restinghr', 'rhr', 'heartrate', 'restingheartrate', 'pulse', 'bpm']);
  const bpIdx = findCol(['bloodpressure', 'bp', 'systolic', 'diastolic']);
  const sleepIdx = findCol(['sleep', 'sleepduration', 'sleephours', 'hours_sleep', 'sleep_hrs']);
  const waterIdx = findCol(['water', 'waterintake', 'waterml', 'hydration', 'liters', 'water_liters']);
  const calIdx = findCol(['calories', 'activecalories', 'cal', 'energy']);
  const dietIdx = findCol(['diet', 'meal', 'nutrition', 'dietfollowed', 'food']);
  const workoutIdx = findCol(['workout', 'exercise', 'training', 'gym']);
  const notesIdx = findCol(['notes', 'remark', 'remarks', 'feedback', 'comments']);
  const statusIdx = findCol(['status', 'condition', 'feeling']);
  const spo2Idx = findCol(['spo2', 'oxygen', 'o2']);
  const sugarIdx = findCol(['glucose', 'bloodsugar', 'sugar', 'fastingglucose', 'postprandial', 'fbs', 'ppbs', 'hba1c']);

  const records: DailyHealthRecord[] = [];
  const clientSet = new Set<string>();
  const dateSet = new Set<string>();

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];

    // Capture complete raw values map for each column heading
    const rawValues: Record<string, string | number> = {};
    headers.forEach((header, colIdx) => {
      const cellVal = row[colIdx];
      if (cellVal !== undefined && cellVal !== null && String(cellVal).trim() !== '') {
        const strVal = String(cellVal).trim();
        const numVal = parseFloat(strVal.replace(/,/g, ''));
        rawValues[header] = (!isNaN(numVal) && /^-?\d+(\.\d+)?$/.test(strVal.replace(/,/g, ''))) ? numVal : strVal;
      } else {
        rawValues[header] = '';
      }
    });

    // Extract client name if client column exists
    let clientName = '';
    if (clientIdx >= 0 && row[clientIdx] !== undefined && row[clientIdx] !== null) {
      clientName = String(row[clientIdx]).trim();
      if (clientName) {
        clientSet.add(clientName);
      }
    }

    // Extract date
    let dateStr = '';
    let rawDateStr = '';
    let dayOfWeek = '';

    if (dateIdx >= 0 && row[dateIdx] !== undefined && row[dateIdx] !== null) {
      rawDateStr = String(row[dateIdx]).trim();
      const parsed = parseSheetDate(rawDateStr);
      if (parsed) {
        dateStr = parsed.canonical;
        dayOfWeek = parsed.dayOfWeek;
        dateSet.add(dateStr);
      } else {
        dateStr = rawDateStr;
        dayOfWeek = 'Entry';
      }
    } else {
      dateStr = `Row ${i + 1}`;
      rawDateStr = dateStr;
      dayOfWeek = 'Entry';
    }

    // Parse numeric health values if columns are present
    const parseNum = (idx: number): number | undefined => {
      if (idx < 0 || row[idx] === undefined || row[idx] === null) return undefined;
      const strVal = String(row[idx]).trim().replace(/[^0-9.-]/g, '');
      if (!strVal) return undefined;
      const val = parseFloat(strVal);
      return isNaN(val) ? undefined : val;
    };

    const steps = parseNum(stepsIdx);
    const weightKg = parseNum(weightIdx);
    const restingHeartRate = parseNum(rhrIdx);
    const sleepDurationHours = parseNum(sleepIdx);
    const activeCalories = parseNum(calIdx);
    const spo2 = parseNum(spo2Idx);
    const bloodGlucose = parseNum(sugarIdx);

    let waterIntakeMl: number | undefined = undefined;
    if (waterIdx >= 0 && row[waterIdx] !== undefined && row[waterIdx] !== null) {
      const rawWater = parseNum(waterIdx);
      if (rawWater !== undefined) {
        waterIntakeMl = rawWater < 15 ? Math.round(rawWater * 1000) : Math.round(rawWater);
      }
    }

    let bloodPressure: string | undefined = undefined;
    let bloodPressureSystolic: number | undefined = undefined;
    let bloodPressureDiastolic: number | undefined = undefined;

    if (bpIdx >= 0 && row[bpIdx] !== undefined && row[bpIdx] !== null) {
      const bpRaw = String(row[bpIdx]).trim();
      if (bpRaw) {
        bloodPressure = bpRaw;
        const parts = bpRaw.split(/[/ -]/).map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n));
        if (parts.length >= 2) {
          bloodPressureSystolic = parts[0];
          bloodPressureDiastolic = parts[1];
        }
      }
    }

    const dietFollowed = dietIdx >= 0 && row[dietIdx] ? String(row[dietIdx]).trim() : undefined;
    const workout = workoutIdx >= 0 && row[workoutIdx] ? String(row[workoutIdx]).trim() : undefined;
    const notes = notesIdx >= 0 && row[notesIdx] ? String(row[notesIdx]).trim() : undefined;
    const status = statusIdx >= 0 && row[statusIdx] ? String(row[statusIdx]).trim() : undefined;

    records.push({
      id: `rec-${tabTitle.replace(/[^a-zA-Z0-9]/g, '_')}-${i}-${clientName || 'row'}`,
      date: dateStr,
      rawDate: rawDateStr,
      dayOfWeek,
      clientName,
      steps,
      weightKg,
      restingHeartRate,
      sleepDurationHours,
      bloodPressure,
      bloodPressureSystolic,
      bloodPressureDiastolic,
      waterIntakeMl,
      activeCalories,
      spo2,
      bloodGlucose,
      dietFollowed,
      workout,
      notes,
      status,
      rawValues
    });
  }

  // Detect whether this tab contains health metrics
  const hasHealthColumns = (
    weightIdx >= 0 || stepsIdx >= 0 || rhrIdx >= 0 || bpIdx >= 0 || 
    sleepIdx >= 0 || waterIdx >= 0 || spo2Idx >= 0 || sugarIdx >= 0
  );

  const hasHealthValues = records.some(r => 
    r.steps !== undefined || 
    r.weightKg !== undefined || 
    r.restingHeartRate !== undefined || 
    r.bloodPressure !== undefined || 
    r.sleepDurationHours !== undefined || 
    r.waterIntakeMl !== undefined
  );

  const hasHealthMetrics = classification.archetype === 'HEALTH_VITALITY' || (hasHealthColumns && hasHealthValues);

  const hasClientColumn = clientIdx >= 0 && clientSet.size > 0;
  const clientColumnName = hasClientColumn ? headers[clientIdx] : undefined;

  const hasDateColumn = dateIdx >= 0 && dateSet.size > 0;
  const dateColumnName = hasDateColumn ? headers[dateIdx] : undefined;

  return {
    sheetId,
    title: tabTitle,
    index,
    rowCount: records.length,
    columnCount: headers.length,
    headers,
    records,
    schema,
    detectedArchetype: classification.archetype,
    archetypeLabel: classification.label,
    archetypeConfidence: classification.confidence,
    hasHealthMetrics,
    hasClientColumn,
    clientColumnName,
    clients: Array.from(clientSet).sort(),
    hasDateColumn,
    dateColumnName,
    dates: Array.from(dateSet).sort().reverse(),
    isEmpty: records.length === 0,
    lastUpdated: Date.now()
  };
}

/**
 * Backward compatibility parser wrapper for single-tab calls
 */
export function parseSheetRowsToHealthRecords(
  rows: any[][], 
  sheetTitle: string = 'Google Sheet'
): SheetParseResult {
  const tabInfo = parseSheetTab(rows, sheetTitle);
  return {
    headers: tabInfo.headers,
    records: tabInfo.records,
    clients: tabInfo.clients
  };
}
