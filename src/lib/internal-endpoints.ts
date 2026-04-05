import type { AuthenticatedUser } from '../types/index.js';

export const DEFAULT_GPU_BUILD_URL = 'https://prod-gpu-infra-build-server.buildfunctions.link';

const DEFAULT_DEV_GPU_BUILD_URL = 'https://dev-gpu-infra-build-server.buildfunctions.link';
const TEST_ACCOUNT_ENV = 'TEST_ACCOUNT';

type InternalRoutingUser = Pick<AuthenticatedUser, 'id' | 'username' | 'email'>;

function shouldUseInternalDevGpuBuildUrl(user: InternalRoutingUser): boolean {
  const testAccount = process.env[TEST_ACCOUNT_ENV]?.trim();
  if (!testAccount) {
    return false;
  }

  const normalizedTestAccount = testAccount.toLowerCase();
  return (
    user.id.trim() === testAccount ||
    user.username?.trim().toLowerCase() === normalizedTestAccount ||
    user.email?.trim().toLowerCase() === normalizedTestAccount
  );
}

export function resolveGpuBuildUrl(
  explicitGpuBuildUrl: string | undefined,
  user: InternalRoutingUser
): string {
  if (explicitGpuBuildUrl) {
    return explicitGpuBuildUrl;
  }

  if (!shouldUseInternalDevGpuBuildUrl(user)) {
    return DEFAULT_GPU_BUILD_URL;
  }

  return DEFAULT_DEV_GPU_BUILD_URL;
}
