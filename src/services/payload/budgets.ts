export function computeBudgets(
    limit: number,
    rulesBudgetPct: number | undefined,
    hasDeepContext: boolean
): { rulesBudget: number; budgetMap: { stable: number; world: number; volatile: number } } {
    const rulesBudget = Math.floor(limit * (rulesBudgetPct ?? 0.10));
    const remainingAfterRules = limit - rulesBudget;

    const budgetMap = hasDeepContext
        ? {
            stable: Math.floor(remainingAfterRules * 0.15),
            world: Math.floor(remainingAfterRules * 0.60),
            volatile: Math.floor(remainingAfterRules * 0.10),
        }
        : {
            stable: Math.floor(remainingAfterRules * 0.25),
            world: Math.floor(remainingAfterRules * 0.40),
            volatile: Math.floor(remainingAfterRules * 0.10),
        };

    return { rulesBudget, budgetMap };
}
