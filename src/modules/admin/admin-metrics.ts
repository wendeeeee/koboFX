import { Injectable } from '@nestjs/common';

/**
 * Hooks for the control metrics (design §10). No metrics backend yet; a later phase exports these.
 *
 * Pages: `break_glass_used_total{action}` (every increment — design §9.2 "pages the security channel
 * immediately") and `break_glass_unreviewed{overdue="true"} > 0` (a use nobody reviewed within 24h).
 * Informational: `approvals_total{action,outcome}`.
 *
 * The counters are this process's; the unreviewed gauge is set by the worker's monitor from the database,
 * so it is right across processes.
 */
@Injectable()
export class AdminMetrics {
  private readonly breakGlassUses = new Map<string, number>();
  private readonly outcomes = new Map<string, number>();
  private unreviewed = { withinWindow: 0, overdue: 0 };

  recordBreakGlassUse(actionType: string): void {
    this.breakGlassUses.set(actionType, (this.breakGlassUses.get(actionType) ?? 0) + 1);
  }

  /** `break_glass_used_total{action}`. */
  breakGlassUsedTotal(): { action: string; count: number }[] {
    return [...this.breakGlassUses.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => a.action.localeCompare(b.action));
  }

  recordOutcome(actionType: string, outcome: string): void {
    const key = `${actionType}|${outcome}`;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
  }

  /** `approvals_total{action,outcome}`. */
  approvalsTotal(): { action: string; outcome: string; count: number }[] {
    return [...this.outcomes.entries()]
      .map(([key, count]) => {
        const [action, outcome] = key.split('|') as [string, string];
        return { action, outcome, count };
      })
      .sort((a, b) => a.action.localeCompare(b.action) || a.outcome.localeCompare(b.outcome));
  }

  recordUnreviewedBreakGlass(counts: { withinWindow: number; overdue: number }): void {
    this.unreviewed = counts;
  }

  /** `break_glass_unreviewed{overdue}`. */
  get breakGlassUnreviewed(): { withinWindow: number; overdue: number } {
    return this.unreviewed;
  }
}
