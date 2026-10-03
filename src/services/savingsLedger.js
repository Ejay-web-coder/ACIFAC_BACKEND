// Savings deposits and withdrawals share one ledger (savings_transactions) and
// both store a positive amount. A member's savings balance is the deposits
// minus the withdrawals; every total of savings goes through this expression.
export const signedSavings = (alias = 'st') => `CASE WHEN ${alias}.transaction_type = 'withdrawal' THEN -${alias}.amount ELSE ${alias}.amount END`;

// 'deposit' / 'withdrawal' as the API shows them.
export const savingsTypeLabel = (alias = 'st') => `CASE WHEN ${alias}.transaction_type = 'withdrawal' THEN 'Withdrawal' ELSE 'Deposit' END`;
