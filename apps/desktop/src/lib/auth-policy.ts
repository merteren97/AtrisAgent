export interface PremiumMembershipSession {
  membership: {
    status: string;
    plan: string;
  };
}

export function hasPremiumAccess(session: PremiumMembershipSession): boolean {
  const status = session.membership.status.trim().toLowerCase();
  const plan = session.membership.plan.trim().toLowerCase();
  return status === 'active' && (plan === 'premium' || plan === 'admin');
}
