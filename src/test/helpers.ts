import { openWorkCoreDB } from '../data/db';
import { generateId } from '../domain/id';
import { WorkCoreService } from '../services/workcoreService';

export const TODAY = '2026-10-15'; // 木曜日

export async function createService(today = TODAY) {
  const db = await openWorkCoreDB(`test_${generateId()}`);
  const service = new WorkCoreService(db, () => today);
  return { db, service };
}
