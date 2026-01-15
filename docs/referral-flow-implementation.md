# Referral Code Flow Implementation Guide

## Overview

This document explains how the referral system works with Privy authentication (Google, Email, or Wallet login) and what needs to be implemented on the frontend.

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. USER CLICKS REFERRAL LINK                                    │
│    https://app.mevu.com/?ref=ABC12345                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. FRONTEND: Home Page Loads                                    │
│    - Capture ?ref=ABC12345 from URL                             │
│    - Store in localStorage/sessionStorage (as backup)            │
│    - Keep ?ref parameter in URL (for transparency/sharing)     │
│    - AUTO-TRIGGER: Open Privy sign-in modal automatically       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. USER AUTHENTICATES WITH PRIVY (Auto-triggered)              │
│    - Sign-in modal opens automatically when ref code detected  │
│    - Google OAuth                                                │
│    - Email (magic link)                                          │
│    - Wallet (MetaMask, WalletConnect, etc.)                      │
│    - Privy creates/retrieves embedded wallet                     │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. FRONTEND: User Registration Flow                             │
│    - User enters username                                        │
│    - Retrieve referralCode from localStorage                     │
│    - Call POST /api/users/register                              │
│      {                                                           │
│        privyUserId: user.id,                                    │
│        username: "newuser",                                     │
│        userJwt: await getAccessToken(),                         │
│        referralCode: "ABC12345"  ← From localStorage            │
│      }                                                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. BACKEND: Registration Processing                             │
│    a) Validate referral code exists                             │
│    b) Get referrer's user ID                                     │
│    c) Create user record with referred_by_user_id                │
│    d) Deploy proxy wallet                                        │
│    e) Return user profile                                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. REFERRAL LINKED                                              │
│    - New user's referred_by_user_id = referrer's user.id        │
│    - Referrer will earn 25% of platform fees from this user     │
└─────────────────────────────────────────────────────────────────┘
```

## Frontend Implementation Requirements

### Step 1: Capture Referral Code and Auto-Trigger Sign-In

When the home page loads, check for the `ref` query parameter, store it, and automatically open the sign-in modal:

```typescript
// On home page component mount (React example)
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom'; // or your routing library
import { usePrivy } from '@privy-io/react-auth';

function HomePage() {
  const [searchParams] = useSearchParams();
  const { login, authenticated } = usePrivy();
  const hasAutoTriggered = useRef(false); // Prevent multiple triggers
  
  useEffect(() => {
    // Check for referral code in URL
    const refCode = searchParams.get('ref');
    
    if (refCode) {
      // Store referral code in localStorage (persists across sessions, as backup)
      localStorage.setItem('referralCode', refCode);
      
      // Keep referral code in URL for transparency and sharing
      // The URL will remain: https://app.mevu.com/?ref=ABC12345
      
      console.log('Referral code captured:', refCode);
      
      // AUTO-TRIGGER: Open sign-in modal automatically if user is not authenticated
      // Only trigger once per page load
      if (!authenticated && !hasAutoTriggered.current) {
        hasAutoTriggered.current = true;
        
        // Small delay to ensure UI is ready
        setTimeout(() => {
          login();
        }, 100);
      }
    }
  }, [searchParams, authenticated, login]);
  
  // ... rest of component
}
```

**Alternative using vanilla JavaScript (if not using React hooks):**

```typescript
// On page load
const urlParams = new URLSearchParams(window.location.search);
const refCode = urlParams.get('ref');

if (refCode) {
  localStorage.setItem('referralCode', refCode);
  
  // Keep referral code in URL for transparency and sharing
  // The URL will remain: https://app.mevu.com/?ref=ABC12345
  
  // AUTO-TRIGGER: Open sign-in modal automatically
  // Note: This assumes you have access to Privy's login function
  // In a React app, use the hook-based approach above instead
  if (typeof window.privyLogin === 'function') {
    setTimeout(() => {
      window.privyLogin();
    }, 100);
  }
}
```

**Important Notes for Auto-Trigger:**
- Only trigger if user is **not already authenticated** (`!authenticated`)
- Use a `useRef` or flag to prevent multiple triggers on re-renders
- Add a small delay (100ms) to ensure the UI is fully loaded
- The modal will show the Mevu onboarding flow where users can enter their details

### Step 1.5: Handle Onboarding Modal

When the sign-in modal auto-opens, Privy will handle authentication. After successful authentication, your onboarding modal should appear where users can:

1. Enter their username
2. Complete profile setup
3. The referral code will be automatically included during registration (see Step 2)

**Example: Onboarding Modal Component**

```typescript
import { usePrivy } from '@privy-io/react-auth';
import { useState, useEffect } from 'react';

function OnboardingModal({ isOpen, onClose }) {
  const { user, authenticated } = usePrivy();
  const [username, setUsername] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  
  // Check if user needs onboarding (not registered yet)
  useEffect(() => {
    if (authenticated && user && isOpen) {
      // Check if user is already registered
      // If not, show onboarding form
    }
  }, [authenticated, user, isOpen]);
  
  const handleSubmit = async () => {
    // Registration logic (see Step 2)
  };
  
  if (!isOpen) return null;
  
  return (
    <div className="onboarding-modal">
      <h2>Welcome to Mevu!</h2>
      <p>Complete your profile to get started</p>
      <input
        type="text"
        placeholder="Choose a username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <button onClick={handleSubmit} disabled={isRegistering}>
        {isRegistering ? 'Creating Account...' : 'Continue'}
      </button>
    </div>
  );
}
```

### Step 2: Pass Referral Code During Registration

When the user completes Privy authentication and registers, include the referral code:

```typescript
import { usePrivy, useWallets } from '@privy-io/react-auth';

function RegisterUser() {
  const { user, authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  
  const register = async (username: string) => {
    if (!authenticated || !user) {
      throw new Error('User not authenticated');
    }
    
    // Get referral code from localStorage (if exists)
    const referralCode = localStorage.getItem('referralCode');
    
    // Get user JWT for session signer
    const userJwt = await getAccessToken();
    
    // Call backend registration with referral code
    const response = await fetch('/api/users/register', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        privyUserId: user.id,
        username,
        userJwt,
        referralCode: referralCode || undefined, // Only include if exists
      }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Registration failed');
    }
    
    const result = await response.json();
    
    // Clear referral code from localStorage after successful registration
    if (referralCode) {
      localStorage.removeItem('referralCode');
    }
    
    return result;
  };
  
  return { register };
}
```

### Step 3: Handle Edge Cases

```typescript
// Check if user already exists (they might have registered before)
// The backend will return existing user if privyUserId already exists
// In this case, referral code won't be applied (user already registered)

// Validate referral code format (optional frontend validation)
function isValidReferralCode(code: string): boolean {
  // Referral codes are 8 uppercase alphanumeric characters
  return /^[A-Z0-9]{8}$/.test(code.toUpperCase());
}

// Handle expired referral codes
// Backend will return error if referral code doesn't exist
// Frontend should handle gracefully and allow registration without referral
```

## Backend Flow Details

### Registration Endpoint: `POST /api/users/register`

**Request Body:**
```json
{
  "privyUserId": "did:privy:clx1234567890",
  "username": "newuser",
  "userJwt": "eyJhbGciOiJIUzI1NiIs...",
  "referralCode": "ABC12345"  // Optional
}
```

**Backend Processing:**

1. **Validates referral code** (if provided):
   - Calls `validateReferralCode(referralCode)` 
   - Looks up user with matching `referral_code` in database
   - Returns referrer's `privy_user_id` if valid

2. **Creates user record**:
   - If referral code is valid, sets `referred_by_user_id` to referrer's `id` (UUID)
   - If invalid or missing, `referred_by_user_id` is `null`

3. **Deploys wallet**:
   - Gets/creates embedded wallet from Privy
   - Adds session signer
   - Deploys proxy wallet (Gnosis Safe)

4. **Returns user profile**:
   ```json
   {
     "success": true,
     "user": {
       "id": "uuid",
       "privyUserId": "did:privy:...",
       "username": "newuser",
       "referredByUserId": "referrer-uuid" // or null
     },
     "proxyWalletAddress": "0x...",
     "embeddedWalletAddress": "0x..."
   }
   ```

### Referral Code Validation

**Location:** `src/services/referral/referral.service.ts`

```typescript
export async function validateReferralCode(referralCode: string): Promise<string | null> {
  // Looks up user by referral_code
  // Returns referrer's privy_user_id if found, null otherwise
  // Case-insensitive (converts to uppercase)
}
```

### User Creation with Referral

**Location:** `src/services/privy/user.service.ts`

```typescript
export async function createUser(request: CreateUserRequest): Promise<UserProfile> {
  // If request.referralCode is provided:
  // 1. Validates referral code
  // 2. Gets referrer's user ID (UUID)
  // 3. Inserts user with referred_by_user_id set
}
```

## Important Notes

### 1. Referral Code Timing & Auto-Trigger
- **Must be captured BEFORE authentication** - Store it when the page loads
- **Auto-trigger sign-in modal** - When referral code is detected, automatically open Privy sign-in modal
- **Must be passed DURING registration** - Include it in the registration API call
- **Only applies to NEW users** - If user already exists, referral code is ignored
- **Prevent duplicate triggers** - Use a ref or flag to ensure modal only opens once per page load

### 2. Referral Code Persistence
- Store in `localStorage` (persists across browser sessions) as a backup
- **Keep referral code in URL** for transparency, sharing, and user visibility
- **Recommendation:** Use `localStorage` as backup, but keep `?ref=CODE` in URL so users can see and share it

### 3. Referral Code Cleanup
- Remove from storage after successful registration
- Keep in storage if registration fails (user can retry)
- Clear on logout (optional - depends on your UX)

### 4. Error Handling
- Invalid referral codes are silently ignored (registration still succeeds)
- Backend logs validation failures but doesn't block registration
- Frontend should handle gracefully

### 5. Multiple Referral Attempts
- If user clicks multiple referral links, last one wins (overwrites in localStorage)
- Referral code is only applied during initial registration
- Once user is created, `referred_by_user_id` cannot be changed

## Testing the Flow

### Test Scenario 1: New User with Valid Referral
1. Visit `https://app.mevu.com/?ref=ABC12345`
2. **Sign-in modal should auto-open automatically**
3. Authenticate with Privy (Google/Email/Wallet)
4. Onboarding modal appears - enter username and register
5. Check database: `referred_by_user_id` should be set to referrer's user ID

### Test Scenario 2: New User without Referral
1. Visit `https://app.mevu.com/` (no ref parameter)
2. Authenticate with Privy
3. Enter username and register
4. Check database: `referred_by_user_id` should be `null`

### Test Scenario 3: Invalid Referral Code
1. Visit `https://app.mevu.com/?ref=INVALID`
2. Authenticate with Privy
3. Enter username and register
4. Check database: `referred_by_user_id` should be `null` (invalid code ignored)

### Test Scenario 4: Existing User
1. User already registered
2. Visit `https://app.mevu.com/?ref=ABC12345`
3. Authenticate (user already exists)
4. Registration returns existing user
5. `referred_by_user_id` remains unchanged (referral only applies to new users)

## API Reference

### Get Referral Link
```
GET /api/referral/link?privyUserId={privyUserId}
```

Returns:
```json
{
  "success": true,
  "referralLink": "https://app.mevu.com/?ref=ABC12345",
  "referralCode": "ABC12345"
}
```

### Register User
```
POST /api/users/register
```

Body:
```json
{
  "privyUserId": "did:privy:...",
  "username": "newuser",
  "userJwt": "jwt-token",
  "referralCode": "ABC12345"  // Optional
}
```

## Summary

The referral flow requires frontend implementation to:
1. ✅ Capture `?ref=CODE` from URL on home page load
2. ✅ Store referral code in localStorage (as backup)
3. ✅ **Auto-trigger Privy sign-in modal** when referral code is detected (if user not authenticated)
4. ✅ Show Mevu onboarding modal after authentication for new users
5. ✅ Pass referral code to `/api/users/register` during registration
6. ✅ Clean up referral code after successful registration

The backend already handles:
- ✅ Validating referral codes
- ✅ Linking users to referrers
- ✅ Tracking referral relationships
- ✅ Calculating referral earnings

