export interface DailyHealthRecord {
  id: string;
  date: string; // YYYY-MM-DD canonical
  rawDate: string; // original string from Sheet
  dayOfWeek: string; // Mon, Tue, etc.
  clientName: string;

  // Normalized metric values (strictly undefined if not in Sheet)
  steps?: number;
  stepGoal?: number;
  activeCalories?: number;
  distanceKm?: number;
  weightKg?: number;
  restingHeartRate?: number; // bpm
  avgHeartRate?: number; // bpm
  maxHeartRate?: number; // bpm
  bloodPressure?: string; // e.g. "120/80"
  bloodPressureSystolic?: number;
  bloodPressureDiastolic?: number;
  spo2?: number; // percentage
  sleepDurationHours?: number; // e.g. 7.5
  sleepScore?: number;
  hrv?: number; // ms
  stressLevel?: number;
  waterIntakeMl?: number;
  bloodGlucose?: number; // mg/dL
  vitalityScore?: number; // compound score if calculable
  dietFollowed?: string;
  workout?: string;
  status?: string;
  notes?: string;

  // Complete raw dynamic columns from Google Sheet exactly as formatted
  rawValues: Record<string, string | number>;
}

export type TimeRange = '7d' | '14d' | '30d' | 'all';

export type ReportViewMode = 
  | 'overview'
  | 'new-clients'
  | 'client-progress'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'sheet-data';

export interface SheetParseResult {
  headers: string[];
  records: DailyHealthRecord[];
  clients: string[];
}

export interface ClientProfileSummary {
  name: string;
  firstDate: string;
  latestDate: string;
  totalRecords: number;
  isNewThisWeek: boolean;
  isNewThisMonth: boolean;
  isActiveThisWeek: boolean;
  hasRecentActivity: boolean; // within last 3 days
  hasNoRecentActivity: boolean; // older than 7 days
  latestRecord?: DailyHealthRecord;
  firstRecord?: DailyHealthRecord;
  // Progress calculations (only if columns exist)
  weightChange?: number; // kg
  avgSteps?: number;
  avgSleep?: number;
  latestBp?: string;
  latestDiet?: string;
  latestWorkout?: string;
  latestNotes?: string;
}

export interface RealtimePulse {
  currentHeartRate?: number;
  liveStepsToday?: number;
  liveActiveCalories?: number;
  lastUpdated: string;
  isPulsing: boolean;
}

export type DataArchetype = 
  | 'HEALTH_VITALITY' 
  | 'FINANCE_SALES' 
  | 'ATTENDANCE_HR' 
  | 'INVENTORY_CATALOG' 
  | 'TASKS_PROJECTS' 
  | 'CUSTOMER_CRM' 
  | 'GENERIC_DATA';

export type ColumnDataType = 
  | 'numeric' 
  | 'currency' 
  | 'percentage' 
  | 'date' 
  | 'boolean' 
  | 'categorical' 
  | 'identifier' 
  | 'entity' 
  | 'text' 
  | 'unknown';

export interface ColumnSchema {
  field: string; // Original sheet header
  normalizedField: string;
  columnIndex: number;
  dataType: ColumnDataType;
  detectedTypeLabel: string;
  isEntity: boolean;
  isDate: boolean;
  isNumeric: boolean;
  currencySymbol?: string;
  stats: {
    min?: number;
    max?: number;
    avg?: number;
    sum?: number;
    uniqueCount: number;
    emptyCount: number;
    sampleValues: string[];
    topCategories?: Array<{ label: string; count: number }>;
  };
}

export type AuthStatus = 
  | 'LOADING' 
  | 'AUTHENTICATED' 
  | 'UNAUTHENTICATED' 
  | 'TOKEN_EXPIRED' 
  | 'ACCESS_DENIED' 
  | 'ERROR';

export interface SheetTabInfo {
  sheetId: number; // Google Sheet tab ID (gid)
  title: string; // Sheet tab name e.g. "Client Health", "Payments", "Attendance"
  index: number; // Order index
  rowCount: number;
  columnCount: number;
  headers: string[];
  records: DailyHealthRecord[];
  
  // Dynamic schema & archetype capabilities
  schema: ColumnSchema[];
  detectedArchetype: DataArchetype;
  archetypeLabel: string;
  archetypeConfidence: number;
  
  hasHealthMetrics: boolean;
  hasClientColumn: boolean;
  clientColumnName?: string;
  clients: string[];
  hasDateColumn: boolean;
  dateColumnName?: string;
  dates: string[];
  isEmpty: boolean;
  lastUpdated: number;
}

export interface SheetMetadata {
  sheetId: string;
  sheetName: string;
  title: string;
  rowCount: number;
  readOnly: boolean;
  lastSyncTimestamp: number;
  syncStatus: 'synced' | 'syncing' | 'error' | 'reconnecting' | 'offline' | 'unconnected';
  sourceType: 'demo' | 'google-sheets-oauth' | 'google-sheets-public' | 'csv-url' | 'empty';
  syncIntervalSec: number;
  availableTabs?: string[];
  currentTab?: string;
  tabs?: SheetTabInfo[];
  errorMessage?: string;
}
