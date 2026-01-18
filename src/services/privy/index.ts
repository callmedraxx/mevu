/**
 * Privy Services Index
 * Re-exports all Privy-related services and types
 */

// Configuration
export { privyConfig, validatePrivyConfig, validateBuilderConfig } from './privy.config';

// Types
export * from './privy.types';

// Services
export { privyService } from './privy.service';
export { PrivySignerAdapter, createPrivySigner } from './privy-signer.adapter';

// User service
export {
  initializeUsersTable,
  createUser,
  getUserByPrivyId,
  getUserByUsername,
  getUserByWalletAddress,
  updateUserProxyWallet,
  updateUserEmbeddedWalletAddress,
  updateUserSessionSigner,
  markOnboardingComplete,
  isUsernameAvailable,
  userExists,
  deleteAllUsers,
} from './user.service';

// Wallet deployment service
export {
  registerUserAndDeployWallet,
  deployProxyWallet,
  setupTokenApprovals,
  getUserWalletInfo,
} from './wallet-deployment.service';
