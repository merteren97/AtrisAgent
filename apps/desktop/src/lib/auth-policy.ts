export interface PremiumMembershipSession {
  appAccess?: { appId: string; allowed: boolean };
  membership: {
    status: string;
    plan: string;
  };
}

export function hasPremiumAccess(session: PremiumMembershipSession): boolean {
  if (session.appAccess) return session.appAccess.appId === 'agent' && session.appAccess.allowed === true;
  const status = session.membership.status.trim().toLowerCase();
  const plan = session.membership.plan.trim().toLowerCase();
  return status === 'active' && (plan === 'premium' || plan === 'admin');
}

export const hasAgentApplicationAccess = (session: PremiumMembershipSession) => session.appAccess?.appId === 'agent' && session.appAccess.allowed === true;
