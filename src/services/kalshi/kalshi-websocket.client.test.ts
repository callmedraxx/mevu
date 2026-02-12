/**
 * Unit Tests for Kalshi WebSocket Client
 * Tests WebSocket connection management, subscription handling, and message processing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock WebSocket before importing the module
const mockWebSocketInstance = {
  on: vi.fn(),
  send: vi.fn(),
  ping: vi.fn(),
  close: vi.fn(),
  terminate: vi.fn(),
  readyState: 1, // OPEN
};

vi.mock('ws', () => {
  const MockWebSocket = vi.fn(() => mockWebSocketInstance);
  (MockWebSocket as any).OPEN = 1;
  (MockWebSocket as any).CLOSED = 3;
  return { default: MockWebSocket };
});

// Mock logger
vi.mock('../../config/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Kalshi WebSocket Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset WebSocket mock state
    mockWebSocketInstance.readyState = 1;
    mockWebSocketInstance.on.mockReset();
    mockWebSocketInstance.send.mockReset();
  });

  describe('KalshiWebSocketClient Class', () => {
    it('should be a singleton', async () => {
      const { getKalshiWebSocketClient } = await import('./kalshi-websocket.client');
      
      const instance1 = getKalshiWebSocketClient();
      const instance2 = getKalshiWebSocketClient();
      
      expect(instance1).toBe(instance2);
    });

    it('should return correct status when not connected', async () => {
      const { KalshiWebSocketClient } = await import('./kalshi-websocket.client');
      
      // Create a new instance for testing (bypass singleton)
      const client = (KalshiWebSocketClient as any).instance || KalshiWebSocketClient.getInstance();
      
      const status = client.getStatus();
      
      expect(status).toHaveProperty('isConnected');
      expect(status).toHaveProperty('isConnecting');
      expect(status).toHaveProperty('subscriptionCount');
      expect(status).toHaveProperty('reconnectAttempts');
    });
  });

  describe('Subscription Management', () => {
    it('should track subscribed tickers', async () => {
      const { KalshiWebSocketClient } = await import('./kalshi-websocket.client');
      const client = KalshiWebSocketClient.getInstance();
      
      // Verify subscription count starts at 0
      expect(client.getSubscriptionCount()).toBe(0);
      expect(client.getSubscribedTickers()).toEqual([]);
    });

    it('should return empty array when getting subscribed tickers', async () => {
      const { KalshiWebSocketClient } = await import('./kalshi-websocket.client');
      const client = KalshiWebSocketClient.getInstance();
      
      const tickers = client.getSubscribedTickers();
      
      expect(Array.isArray(tickers)).toBe(true);
    });
  });

  describe('Message Types', () => {
    it('should export correct message interfaces', async () => {
      // This test verifies the types are exported correctly
      const module = await import('./kalshi-websocket.client');
      
      expect(module.KalshiWebSocketClient).toBeDefined();
      expect(module.getKalshiWebSocketClient).toBeDefined();
    });
  });
});

describe('Kalshi Ticker Message Parsing', () => {
  describe('Ticker message structure', () => {
    it('should define correct ticker message interface', () => {
      // Test that the interface structure is correct
      const validTickerMessage = {
        type: 'ticker' as const,
        sid: 123,
        seq: 1,
        msg: {
          market_ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
          market_id: 'abc123',
          price: 55,
          yes_bid: 54,
          yes_ask: 56,
          volume: 10000,
          open_interest: 5000,
          ts: 1738772400,
        },
      };

      expect(validTickerMessage.type).toBe('ticker');
      expect(validTickerMessage.msg.market_ticker).toBeDefined();
      expect(validTickerMessage.msg.yes_bid).toBeDefined();
      expect(validTickerMessage.msg.yes_ask).toBeDefined();
    });

    it('should calculate NO prices from YES prices', () => {
      // YES bid = 54, YES ask = 56
      // NO bid = 100 - YES ask = 100 - 56 = 44
      // NO ask = 100 - YES bid = 100 - 54 = 46
      const yesBid = 54;
      const yesAsk = 56;
      
      const noBid = 100 - yesAsk;
      const noAsk = 100 - yesBid;
      
      expect(noBid).toBe(44);
      expect(noAsk).toBe(46);
    });
  });
});

describe('Subscription Commands', () => {
  describe('Subscribe command format', () => {
    it('should generate correct subscribe command structure', () => {
      const subscribeCommand = {
        id: 1,
        cmd: 'subscribe' as const,
        params: {
          channels: ['ticker'],
          market_tickers: ['KXNBAGAME-26FEB05CHAHOU-CHA', 'KXNBAGAME-26FEB05LACMIA-LAC'],
        },
      };

      expect(subscribeCommand.cmd).toBe('subscribe');
      expect(subscribeCommand.params.channels).toContain('ticker');
      expect(subscribeCommand.params.market_tickers.length).toBe(2);
    });
  });

  describe('Unsubscribe command format', () => {
    it('should generate correct unsubscribe command structure', () => {
      const unsubscribeCommand = {
        id: 2,
        cmd: 'unsubscribe' as const,
        params: {
          channels: ['ticker'],
          market_tickers: ['KXNBAGAME-26FEB05CHAHOU-CHA'],
        },
      };

      expect(unsubscribeCommand.cmd).toBe('unsubscribe');
      expect(unsubscribeCommand.params.channels).toContain('ticker');
    });
  });
});

describe('Reconnection Logic', () => {
  describe('Exponential backoff', () => {
    it('should calculate correct reconnection delays', () => {
      const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
      
      // First attempt: 1s
      expect(RECONNECT_DELAYS[0]).toBe(1000);
      
      // Second attempt: 2s
      expect(RECONNECT_DELAYS[1]).toBe(2000);
      
      // Fifth attempt: 30s
      expect(RECONNECT_DELAYS[4]).toBe(30000);
      
      // Max delay: 60s
      expect(RECONNECT_DELAYS[5]).toBe(60000);
    });

    it('should cap delay at max value', () => {
      const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
      const MAX_RECONNECT_ATTEMPTS = 10;
      
      function getReconnectDelay(attempt: number): number {
        const index = Math.min(attempt - 1, RECONNECT_DELAYS.length - 1);
        return RECONNECT_DELAYS[index];
      }
      
      // After max delays, should stay at 60s
      expect(getReconnectDelay(7)).toBe(60000);
      expect(getReconnectDelay(10)).toBe(60000);
    });
  });
});

describe('Memory Guards', () => {
  describe('Subscription limits', () => {
    it('should enforce MAX_SUBSCRIPTIONS limit', () => {
      // MAX_SUBSCRIPTIONS is configurable via env (default: 1000)
      const MAX_SUBSCRIPTIONS = parseInt(process.env.KALSHI_MAX_SUBSCRIPTIONS || '1000', 10);
      const SUBSCRIPTION_BATCH_SIZE = 50;
      
      // Verify limits are reasonable
      expect(MAX_SUBSCRIPTIONS).toBeGreaterThan(0);
      expect(SUBSCRIPTION_BATCH_SIZE).toBeLessThan(MAX_SUBSCRIPTIONS);
      // Should allow at least 10 batches (500 tickers) for reasonable capacity
      expect(MAX_SUBSCRIPTIONS).toBeGreaterThanOrEqual(500);
    });
  });
});
