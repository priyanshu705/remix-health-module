import { SheetTabInfo, DailyHealthRecord, ColumnSchema } from '../types';
import { getMondayToSundayWeekRange, getMonthRange, parseSheetDate } from './dateUtils';

export interface UniversalKPICard {
  id: string;
  field: string;
  label: string;
  value: string | number;
  subValue?: string;
  trendDirection?: 'up' | 'down' | 'neutral';
  dataType: string;
  iconType: 'currency' | 'numeric' | 'percent' | 'count' | 'time' | 'entity';
}

export interface UniversalAnalyticsResult {
  totalRecords: number;
  kpiCards: UniversalKPICard[];
  hasEntities: boolean;
  entityColumnName?: string;
  uniqueEntitiesCount: number;
  topEntities: Array<{ name: string; count: number }>;
  hasDates: boolean;
  dateColumnName?: string;
  earliestDate?: string;
  latestDate?: string;
  recordsThisWeek: number;
  recordsThisMonth: number;
  categoryDistribution?: {
    columnName: string;
    items: Array<{ label: string; count: number; percentage: number }>;
  };
  timeSeriesData: Array<{ date: string; [key: string]: any }>;
  timeSeriesMetrics: Array<{ key: string; label: string; color: string }>;
}

const PALETTE = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899', '#3b82f6'];

/**
 * Computes universal analytics and KPIs for ANY worksheet dynamically.
 */
export function computeUniversalAnalytics(
  tabInfo: SheetTabInfo,
  activeRecords: DailyHealthRecord[] = tabInfo.records
): UniversalAnalyticsResult {
  const records = activeRecords;
  const schemas = tabInfo.schema || [];

  const totalRecords = records.length;
  const kpiCards: UniversalKPICard[] = [];

  // 1. Primary Record Count KPI
  kpiCards.push({
    id: 'kpi-total-records',
    field: 'Total Records',
    label: 'Total Entries',
    value: totalRecords.toLocaleString(),
    subValue: `${tabInfo.columnCount} columns detected`,
    dataType: 'numeric',
    iconType: 'count'
  });

  // 2. Entity Count KPI (if tab has entity/client column)
  const hasEntities = tabInfo.hasClientColumn && tabInfo.clients.length > 0;
  const entityColumnName = tabInfo.clientColumnName;
  const uniqueEntitiesCount = tabInfo.clients.length;

  const entityCounts = new Map<string, number>();
  if (hasEntities) {
    records.forEach(r => {
      const name = r.clientName;
      if (name) {
        entityCounts.set(name, (entityCounts.get(name) || 0) + 1);
      }
    });

    kpiCards.push({
      id: 'kpi-entities',
      field: entityColumnName || 'Entities',
      label: `Unique ${entityColumnName || 'Entities'}`,
      value: uniqueEntitiesCount.toLocaleString(),
      subValue: 'Active in worksheet',
      dataType: 'entity',
      iconType: 'entity'
    });
  }

  const topEntities = Array.from(entityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // 3. Dynamic Numeric / Currency / Percentage KPI Cards
  const numericSchemas = schemas.filter(s => s.isNumeric && s.stats.sum !== undefined);

  // Take up to 4 prominent numeric columns
  for (let i = 0; i < Math.min(4, numericSchemas.length); i++) {
    const col = numericSchemas[i];
    const sum = col.stats.sum ?? 0;
    const avg = col.stats.avg ?? 0;

    let formattedVal = '';
    let iconType: UniversalKPICard['iconType'] = 'numeric';

    if (col.dataType === 'currency') {
      const sym = col.currencySymbol || '$';
      formattedVal = `${sym}${sum >= 1000 ? sum.toLocaleString(undefined, { maximumFractionDigits: 2 }) : sum.toFixed(2)}`;
      iconType = 'currency';
    } else if (col.dataType === 'percentage') {
      formattedVal = `${avg.toFixed(1)}%`;
      iconType = 'percent';
    } else {
      formattedVal = sum >= 1000 ? sum.toLocaleString() : String(sum);
      iconType = 'numeric';
    }

    kpiCards.push({
      id: `kpi-col-${col.columnIndex}`,
      field: col.field,
      label: col.field,
      value: formattedVal,
      subValue: col.dataType === 'percentage' 
        ? `Avg across ${records.length} rows` 
        : `Avg: ${avg.toLocaleString()} • Range: ${col.stats.min} – ${col.stats.max}`,
      dataType: col.dataType,
      iconType
    });
  }

  // 4. Date Analytics
  const hasDates = tabInfo.hasDateColumn && tabInfo.dates.length > 0;
  const dateColumnName = tabInfo.dateColumnName;
  const dates = tabInfo.dates;
  const earliestDate = dates.length > 0 ? dates[dates.length - 1] : undefined;
  const latestDate = dates.length > 0 ? dates[0] : undefined;

  let recordsThisWeek = 0;
  let recordsThisMonth = 0;

  if (hasDates && latestDate) {
    const latestDateObj = new Date(latestDate);
    const weekRange = getMondayToSundayWeekRange(latestDateObj);
    const monthRange = getMonthRange(latestDateObj.getFullYear(), latestDateObj.getMonth() + 1);

    records.forEach(r => {
      if (r.date >= weekRange.startDateYmd && r.date <= weekRange.endDateYmd) {
        recordsThisWeek++;
      }
      if (r.date >= monthRange.startDateYmd && r.date <= monthRange.endDateYmd) {
        recordsThisMonth++;
      }
    });

    if (recordsThisWeek > 0) {
      kpiCards.push({
        id: 'kpi-week-entries',
        field: 'Recent Activity',
        label: 'Active This Week',
        value: recordsThisWeek.toLocaleString(),
        subValue: `Between ${weekRange.startDateYmd} and ${weekRange.endDateYmd}`,
        dataType: 'date',
        iconType: 'time'
      });
    }
  }

  // 5. Category Distribution (for first categorical column found)
  let categoryDistribution: UniversalAnalyticsResult['categoryDistribution'];
  const catSchema = schemas.find(s => s.dataType === 'categorical' && s.stats.topCategories && s.stats.topCategories.length > 0);

  if (catSchema && catSchema.stats.topCategories) {
    const totalCatHits = catSchema.stats.topCategories.reduce((acc, c) => acc + c.count, 0);
    categoryDistribution = {
      columnName: catSchema.field,
      items: catSchema.stats.topCategories.map(c => ({
        label: c.label,
        count: c.count,
        percentage: totalCatHits > 0 ? Math.round((c.count / totalCatHits) * 100) : 0
      }))
    };
  }

  // 6. Time Series Data Preparation (for charts)
  const timeSeriesData: Array<{ date: string; [key: string]: any }> = [];
  const timeSeriesMetrics: Array<{ key: string; label: string; color: string }> = [];

  if (hasDates && numericSchemas.length > 0) {
    const topNumeric = numericSchemas.slice(0, 3);
    topNumeric.forEach((col, idx) => {
      timeSeriesMetrics.push({
        key: `col_${col.columnIndex}`,
        label: col.field,
        color: PALETTE[idx % PALETTE.length]
      });
    });

    // Group records by date
    const dateMap = new Map<string, { count: number; sums: Record<string, number> }>();
    records.forEach(r => {
      if (!r.date || r.date.startsWith('Row ')) return;
      if (!dateMap.has(r.date)) {
        dateMap.set(r.date, { count: 0, sums: {} });
      }
      const item = dateMap.get(r.date)!;
      item.count++;

      topNumeric.forEach(col => {
        const raw = r.rawValues[col.field];
        if (raw !== undefined && raw !== null && raw !== '') {
          const num = parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
          if (!isNaN(num)) {
            const key = `col_${col.columnIndex}`;
            item.sums[key] = (item.sums[key] || 0) + num;
          }
        }
      });
    });

    // Sort chronologically ascending
    const sortedDates = Array.from(dateMap.keys()).sort();
    sortedDates.forEach(d => {
      const item = dateMap.get(d)!;
      const point: { date: string; [key: string]: any } = { date: d };
      topNumeric.forEach(col => {
        const key = `col_${col.columnIndex}`;
        if (item.sums[key] !== undefined) {
          // average for the day
          point[key] = Math.round((item.sums[key] / item.count) * 10) / 10;
        }
      });
      timeSeriesData.push(point);
    });
  }

  return {
    totalRecords,
    kpiCards,
    hasEntities,
    entityColumnName,
    uniqueEntitiesCount,
    topEntities,
    hasDates,
    dateColumnName,
    earliestDate,
    latestDate,
    recordsThisWeek,
    recordsThisMonth,
    categoryDistribution,
    timeSeriesData,
    timeSeriesMetrics
  };
}
