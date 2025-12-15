#!/bin/bash

# Test script for Privy proxy wallet creation
# This script tests the user registration and wallet deployment endpoints

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "Testing Privy Proxy Wallet Creation"
echo "===================================="
echo ""

# Test 1: Health check
echo "1. Testing health endpoint..."
curl -s "${BASE_URL}/health" | jq .
echo ""
echo ""

# Test 2: Check username availability
echo "2. Testing username availability check..."
curl -s -X GET "${BASE_URL}/api/users/check-username/testuser123" | jq .
echo ""
echo ""

# Test 3: Register user and deploy wallet
echo "3. Testing user registration and wallet deployment..."
echo "Note: This requires valid Privy credentials and a session signer"
echo ""

# Example request (you'll need to replace with actual values)
cat << EOF
Example curl command:
curl -X POST "${BASE_URL}/api/users/register" \\
  -H "Content-Type: application/json" \\
  -d '{
    "privyUserId": "did:privy:YOUR_PRIVY_USER_ID",
    "username": "testuser123",
    "embeddedWalletAddress": "0xYOUR_EMBEDDED_WALLET_ADDRESS"
  }'
EOF

echo ""
echo ""

# Test 4: Get user by Privy ID
echo "4. Testing get user by Privy ID..."
echo "Replace YOUR_PRIVY_USER_ID with actual value"
cat << EOF
curl -X GET "${BASE_URL}/api/users/did:privy:YOUR_PRIVY_USER_ID"
EOF

echo ""
echo ""

# Test 5: Get user wallet info
echo "5. Testing get wallet info..."
cat << EOF
curl -X GET "${BASE_URL}/api/users/did:privy:YOUR_PRIVY_USER_ID/wallet"
EOF

echo ""
echo ""

echo "Testing complete!"
echo ""
echo "To test with actual data:"
echo "1. Make sure your .env file has PRIVY_APP_ID and PRIVY_APP_SECRET"
echo "2. Make sure BUILDER_SIGNING_SERVER_URL is set (or running on localhost:5001)"
echo "3. Use a valid Privy user ID and embedded wallet address from your frontend"
echo "4. Ensure the user has authorized a session signer via the Privy SDK"
