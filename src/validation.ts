export type OperationType = 'BANK_TRANSFER' | 'CASH_DEPOSIT' | 'CHECK_DEPOSIT' | 'UNKNOWN';
export type ExtractedReceipt = {
  operationType: OperationType;
  bank: string | null;
  reference: string | null;
  amount: number | null;
  currency: 'GTQ' | 'USD' | null;
  transactionDate: string | null;
  transactionTime: string | null;
  destinationAccount: string | null;
  suspectedTampering: boolean;
  anomalies: string[];
};
export type Decision = { status: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED'; reason: string };

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}

export function guatemalaToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

export function decideReceipt(r: ExtractedReceipt, today: string): Decision {
  if (r.operationType === 'CHECK_DEPOSIT') return { status: 'REJECTED', reason: 'CHECK_DEPOSIT' };
  if (r.operationType === 'UNKNOWN') return { status: 'REVIEW_REQUIRED', reason: 'UNKNOWN_OPERATION' };
  if (!r.transactionDate || !validDate(r.transactionDate)) return { status: 'REVIEW_REQUIRED', reason: 'UNREADABLE_DATE' };
  const ageDays = (Date.parse(today + 'T00:00:00Z') - Date.parse(r.transactionDate + 'T00:00:00Z')) / 86_400_000;
  if (ageDays > 2) return { status: 'REJECTED', reason: 'EXPIRED_RECEIPT' };
  if (ageDays < 0) return { status: 'REVIEW_REQUIRED', reason: 'FUTURE_DATE' };
  if (r.anomalies.includes('AI_OUTPUT_NORMALIZED_FROM_PROSE')) return { status: 'REVIEW_REQUIRED', reason: 'AI_OUTPUT_UNVERIFIED' };
  if (r.suspectedTampering || r.anomalies.length > 0) return { status: 'REVIEW_REQUIRED', reason: 'POSSIBLE_TAMPERING' };
  if (!r.bank || !r.reference || !Number.isFinite(r.amount) || (r.amount ?? 0) <= 0 || !r.currency) {
    return { status: 'REVIEW_REQUIRED', reason: 'MISSING_REQUIRED_FIELDS' };
  }
  return { status: 'APPROVED', reason: 'DOCUMENT_CHECKS_PASSED' };
}

export function normalizeClaim(r: ExtractedReceipt): string | null {
  if (!r.bank || !r.reference || r.operationType === 'UNKNOWN') return null;
  const bank = r.bank.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const reference = r.reference.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!bank || !reference) return null;
  return `${bank}:${r.operationType}:${reference}`;
}
