import type { ExtractedReceipt, Decision } from './validation';

export function normalizeAccount(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  // Require a fully readable account number; never match masked or redacted numbers.
  if (/[*xX•…]/.test(raw) || /\.{2,}/.test(raw)) return null;
  if (!/^[0-9\s-]+$/.test(raw)) return null;
  const digits = raw.replace(/[\s-]/g, '');
  return /^\d{6,24}$/.test(digits) ? digits : null;
}

export function decideAccount(
  initial: Decision, account: string | null, activeAccounts: number,
  isAllowed: boolean,
): Decision {
  // Keep objective rejections and uncertainty from visual analysis.
  if (initial.status !== 'APPROVED') return initial;
  if (!normalizeAccount(account)) {
    return { status: 'REVIEW_REQUIRED', reason: 'DESTINATION_ACCOUNT_UNREADABLE' };
  }
  if (activeAccounts === 0) {
    return { status: 'REVIEW_REQUIRED', reason: 'NO_ALLOWED_ACCOUNTS_CONFIGURED' };
  }
  if (!isAllowed) {
    return { status: 'REJECTED', reason: 'DESTINATION_ACCOUNT_NOT_ALLOWED' };
  }
  return initial;
}

export async function verifyDestinationAccount(
  db: D1Database, receipt: ExtractedReceipt, decision: Decision,
): Promise<Decision> {
  if (decision.status !== 'APPROVED') return decision;
  const account = normalizeAccount(receipt.destinationAccount);
  if (!account) return decideAccount(decision, null, 1, false);
  const [configured, match] = await db.batch([
    db.prepare('SELECT COUNT(*) AS total FROM allowed_bank_accounts WHERE is_active = 1'),
    db.prepare('SELECT 1 AS found FROM allowed_bank_accounts WHERE account_number = ? AND is_active = 1 LIMIT 1').bind(account),
  ]);
  const active = Number((configured.results[0] as { total: number } | undefined)?.total ?? 0);
  return decideAccount(decision, account, active, match.results.length > 0);
}
