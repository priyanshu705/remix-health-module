import { DataArchetype, ColumnSchema } from '../types';

interface ArchetypeProfile {
  type: DataArchetype;
  label: string;
  keywords: string[];
  requiredSignals?: number;
}

const PROFILES: ArchetypeProfile[] = [
  {
    type: 'HEALTH_VITALITY',
    label: 'Health & Vitality',
    keywords: [
      'weight', 'wt', 'bodyweight', 'kg', 'lbs', 'step', 'steps', 'stepcount',
      'heartrate', 'rhr', 'pulse', 'bpm', 'bloodpressure', 'bp', 'systolic',
      'diastolic', 'sleep', 'sleephours', 'water', 'hydration', 'liters',
      'spo2', 'oxygen', 'glucose', 'sugar', 'bloodsugar', 'calorie', 'calories',
      'workout', 'exercise', 'diet', 'meal', 'nutrition', 'vitality'
    ],
    requiredSignals: 2
  },
  {
    type: 'FINANCE_SALES',
    label: 'Finance & Sales',
    keywords: [
      'amount', 'price', 'revenue', 'cost', 'profit', 'total', 'subtotal',
      'invoice', 'payment', 'paid', 'balance', 'fee', 'currency', 'sales',
      'discount', 'tax', 'salary', 'transaction', 'transamount', 'gross', 'net'
    ],
    requiredSignals: 2
  },
  {
    type: 'ATTENDANCE_HR',
    label: 'Attendance & HR',
    keywords: [
      'attendance', 'employee', 'employeename', 'staff', 'shift', 'checkin',
      'checkout', 'present', 'absent', 'leave', 'department', 'overtime',
      'roster', 'timesheet', 'clockin', 'clockout', 'attendancestatus'
    ],
    requiredSignals: 2
  },
  {
    type: 'INVENTORY_CATALOG',
    label: 'Inventory & Catalog',
    keywords: [
      'sku', 'stock', 'quantity', 'qty', 'inventory', 'item', 'itemname',
      'product', 'productname', 'reorder', 'warehouse', 'supplier', 'unitprice',
      'catalog', 'stocklevel', 'availableqty'
    ],
    requiredSignals: 2
  },
  {
    type: 'TASKS_PROJECTS',
    label: 'Tasks & Projects',
    keywords: [
      'task', 'taskname', 'priority', 'status', 'assignee', 'duedate',
      'sprint', 'milestone', 'deadline', 'completion', 'stage', 'backlog',
      'progress', 'subtask'
    ],
    requiredSignals: 2
  },
  {
    type: 'CUSTOMER_CRM',
    label: 'Customer & CRM',
    keywords: [
      'customer', 'client', 'lead', 'deal', 'dealvalue', 'stage', 'pipeline',
      'contact', 'phone', 'email', 'company', 'organization', 'accountmanager',
      'conversion', 'source'
    ],
    requiredSignals: 2
  }
];

export interface ClassificationResult {
  archetype: DataArchetype;
  label: string;
  confidence: number;
  primaryEntityColumn?: ColumnSchema;
  primaryDateColumn?: ColumnSchema;
  primaryNumericColumns: ColumnSchema[];
  primaryCategoryColumn?: ColumnSchema;
}

/**
 * Evaluates the detected schema and column values to classify the worksheet's archetype.
 * Follows Rule 7: "Classification must be based on schema/content, NOT worksheet name alone.
 * If confidence is low: Use Generic Data. Never force incorrect specialized interpretation."
 */
export function classifyWorksheet(
  tabTitle: string,
  headers: string[],
  schemas: ColumnSchema[]
): ClassificationResult {
  const normalizedTitle = tabTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedHeaders = schemas.map(s => s.normalizedField);

  let bestType: DataArchetype = 'GENERIC_DATA';
  let bestLabel = 'Universal Data';
  let highestScore = 0;

  for (const profile of PROFILES) {
    let score = 0;
    let keywordMatches = 0;

    // 1. Column header keyword matching
    for (const h of normalizedHeaders) {
      for (const kw of profile.keywords) {
        if (h.includes(kw)) {
          keywordMatches++;
          score += 15;
          break; // Count once per column
        }
      }
    }

    // 2. Tab title keyword matching (moderate weight, never sole decider)
    for (const kw of profile.keywords) {
      if (normalizedTitle.includes(kw)) {
        score += 10;
        break;
      }
    }

    // 3. Schema type corroboration
    if (profile.type === 'FINANCE_SALES') {
      const currencyCols = schemas.filter(s => s.dataType === 'currency').length;
      score += currencyCols * 12;
    } else if (profile.type === 'HEALTH_VITALITY') {
      // Must have at least 2 distinct health keyword hits to qualify
      if (keywordMatches < 2) {
        score = 0;
      }
    }

    // Must satisfy required minimum signals
    if (profile.requiredSignals && keywordMatches < profile.requiredSignals) {
      score = 0;
    }

    if (score > highestScore) {
      highestScore = score;
      bestType = profile.type;
      bestLabel = profile.label;
    }
  }

  // Confidence calculation (capped at 100%)
  const confidence = Math.min(100, Math.round(highestScore * 1.5));

  // If confidence is lower than threshold (35%), strictly default to Generic Data
  if (confidence < 35) {
    bestType = 'GENERIC_DATA';
    bestLabel = 'Universal Data';
  }

  // Identify Primary Entity Column
  // Prefer columns flagged as isEntity, or headers containing entity keywords
  const primaryEntityColumn = schemas.find(s => s.isEntity) || 
    schemas.find(s => s.dataType === 'text' && (
      s.normalizedField.includes('name') || 
      s.normalizedField.includes('client') || 
      s.normalizedField.includes('user') ||
      s.normalizedField.includes('employee') ||
      s.normalizedField.includes('customer') ||
      s.normalizedField.includes('member')
    ));

  // Identify Primary Date Column
  const primaryDateColumn = schemas.find(s => s.isDate);

  // Identify Primary Numeric Columns (sorted by filled coverage / variance)
  const primaryNumericColumns = schemas.filter(s => s.isNumeric);

  // Identify Primary Categorical / Status Column
  const primaryCategoryColumn = schemas.find(s => 
    s.dataType === 'categorical' || 
    s.normalizedField.includes('status') || 
    s.normalizedField.includes('category') ||
    s.normalizedField.includes('department') ||
    s.normalizedField.includes('type')
  );

  return {
    archetype: bestType,
    label: bestLabel,
    confidence,
    primaryEntityColumn,
    primaryDateColumn,
    primaryNumericColumns,
    primaryCategoryColumn
  };
}
