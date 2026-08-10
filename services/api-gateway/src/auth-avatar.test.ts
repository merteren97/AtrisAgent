import assert from 'node:assert/strict';
import { AtrisAuthService, normalizeAvatarUrl } from './auth';

const relativeAvatar = '/uploads/profiles/mert-avatar.png';
const absoluteAvatar = 'https://cdn.example.test/avatars/mert.png';

assert.equal(
  normalizeAvatarUrl(relativeAvatar, 'https://atrishub.com'),
  'https://atrishub.com/uploads/profiles/mert-avatar.png',
  'managed AtrisHub upload paths become absolute desktop-safe URLs',
);
assert.equal(
  normalizeAvatarUrl(absoluteAvatar, 'https://atrishub.com'),
  absoluteAvatar,
  'already absolute HTTPS avatar URLs remain unchanged',
);
assert.equal(
  normalizeAvatarUrl('http://cdn.example.test/avatar.png', 'https://atrishub.com'),
  null,
  'insecure remote avatar URLs are rejected',
);
assert.equal(
  normalizeAvatarUrl('/uploads/profiles/dev.png', 'http://127.0.0.1:3000'),
  'http://127.0.0.1:3000/uploads/profiles/dev.png',
  'loopback HTTP remains usable for local development',
);

const fetchImpl = async (input: string | URL): Promise<Response> => {
  const path = new URL(String(input)).pathname;
  if (path === '/api/auth/login') {
    return Response.json({
      token: 'avatar-login-token',
      user: { id: 'avatar-user', email: 'mert@example.test', avatarUrl: relativeAvatar },
      membership: { status: 'active', plan: 'Premium' },
    });
  }
  if (path === '/api/auth/me') {
    return Response.json({
      user: { id: 'avatar-user', email: 'mert@example.test', avatarUrl: relativeAvatar },
      membership: { status: 'active', plan: 'Premium' },
    });
  }
  return Response.json({ error: 'not found' }, { status: 404 });
};

const service = new AtrisAuthService({
  baseUrl: 'https://hub.example.test',
  fetchImpl,
});

const login = await service.login({ email: 'mert@example.test', password: 'not-a-real-password' });
assert.equal(login.status, 200);
assert.equal(
  (login.body as any).user.avatarUrl,
  'https://hub.example.test/uploads/profiles/mert-avatar.png',
  'login responses normalize relative Hub avatars before they reach the desktop session',
);

const authenticated = await service.authenticate('avatar-login-token', 'GET');
assert.equal(
  authenticated.session.user.avatarUrl,
  'https://hub.example.test/uploads/profiles/mert-avatar.png',
  '/auth/me session refreshes preserve a fetchable absolute avatar URL',
);

console.log('API Gateway avatar normalization tests passed.');
