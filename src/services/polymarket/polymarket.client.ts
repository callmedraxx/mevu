/**
 * HTTP client for Polymarket Gamma API
 * Handles retry logic, error handling, rate limiting, and logging
 */

import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { logger } from '../../config/logger';
import { PolymarketError, ErrorCode } from '../../utils/errors';
import { PolymarketApiResponse, PriceHistoryResponse, OrderBookResponse, OrderBookRequest } from './polymarket.types';

const API_BASE_URL = process.env.POLYMARKET_API_BASE_URL || 'https://gamma-api.polymarket.com';
const CLOB_API_BASE_URL = process.env.POLYMARKET_CLOB_API_BASE_URL || 'https://clob.polymarket.com';
const API_TIMEOUT = parseInt(process.env.POLYMARKET_API_TIMEOUT || '10000', 10);
const MAX_RETRIES = parseInt(process.env.POLYMARKET_MAX_RETRIES || '3', 10);

/**
 * Calculate exponential backoff delay
 */
function getRetryDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 10000);
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: AxiosError): boolean {
  if (!error.response) {
    // Network error or timeout
    return true;
  }
  
  const status = error.response.status;
  // Retry on 5xx errors and 429 (rate limit)
  return status >= 500 || status === 429;
}

/**
 * Polymarket API HTTP Client
 */
export class PolymarketClient {
  private client: AxiosInstance;
  private clobClient: AxiosInstance;
  private requestCount: number = 0;
  private lastRequestTime: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: API_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    // Separate client for CLOB API to support concurrent requests
    this.clobClient = axios.create({
      baseURL: CLOB_API_BASE_URL,
      timeout: API_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    // Request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        this.requestCount++;
        this.lastRequestTime = Date.now();
        // logger.info({
        //   message: 'Polymarket API request',
        //   method: config.method?.toUpperCase(),
        //   url: config.url,
        //   params: config.params,
        // });
        return config;
      },
      (error) => {
        logger.error({
          message: 'Polymarket API request error',
          error: error.message,
        });
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        // logger.info({
        //   message: 'Polymarket API response',
        //   status: response.status,
        //   url: response.config.url,
        //   dataLength: Array.isArray(response.data?.data) ? response.data.data.length : 0,
        // });
        return response;
      },
      (error: AxiosError) => {
        logger.error({
          message: 'Polymarket API response error',
          status: error.response?.status,
          url: error.config?.url,
          error: error.message,
        });
        return Promise.reject(error);
      }
    );

    // CLOB client request interceptor for logging
    this.clobClient.interceptors.request.use(
      (config) => {
        // logger.info({
        //   message: 'Polymarket CLOB API request',
        //   method: config.method?.toUpperCase(),
        //   url: config.url,
        //   params: config.params,
        // });
        return config;
      },
      (error) => {
        logger.error({
          message: 'Polymarket CLOB API request error',
          error: error.message,
        });
        return Promise.reject(error);
      }
    );

    // CLOB client response interceptor for logging
    this.clobClient.interceptors.response.use(
      (response) => {
        // logger.info({
        //   message: 'Polymarket CLOB API response',
        //   status: response.status,
        //   url: response.config.url,
        //   historyLength: Array.isArray(response.data?.history) ? response.data.history.length : 0,
        // });
        return response;
      },
      (error: AxiosError) => {
        logger.error({
          message: 'Polymarket CLOB API response error',
          status: error.response?.status,
          url: error.config?.url,
          error: error.message,
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Make GET request with retry logic
   */
  async get<T = PolymarketApiResponse>(
    path: string,
    params?: Record<string, string | number | boolean | string[] | undefined>,
    retries: number = MAX_RETRIES
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: path,
      params: this.sanitizeParams(params),
    };

    let lastError: AxiosError | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = getRetryDelay(attempt - 1);
          logger.warn({
            message: 'Retrying Polymarket API request',
            attempt,
            maxRetries: retries,
            delay,
            url: path,
          });
          await this.sleep(delay);
        }

        const response = await this.client.request<T>(config);
        return response.data;
      } catch (error) {
        lastError = error as AxiosError;

        if (!isRetryableError(lastError) || attempt === retries) {
          break;
        }

        // Check for rate limiting
        if (lastError.response?.status === 429) {
          const retryAfter = lastError.response.headers['retry-after'];
          if (retryAfter) {
            const delay = parseInt(retryAfter, 10) * 1000;
            logger.warn({
              message: 'Rate limited by Polymarket API',
              retryAfter: delay,
              url: path,
            });
            await this.sleep(delay);
          }
        }
      }
    }

    // Handle final error
    return this.handleError(lastError!, path);
  }

  /**
   * Sanitize parameters - remove undefined values
   */
  private sanitizeParams(
    params?: Record<string, string | number | boolean | string[] | undefined>
  ): Record<string, string | number | boolean | string[]> | undefined {
    if (!params) return undefined;

    const sanitized: Record<string, string | number | boolean | string[]> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        sanitized[key] = value;
      }
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  /**
   * Handle API errors and convert to custom errors
   */
  private handleError(error: AxiosError, path: string): never {
    logger.error({
      message: 'Polymarket API request failed',
      url: path,
      status: error.response?.status,
      statusText: error.response?.statusText,
      error: error.message,
      responseData: error.response?.data,
    });

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new PolymarketError(
        ErrorCode.POLYMARKET_TIMEOUT,
        `Request timeout: ${error.message}`
      );
    }

    if (error.response) {
      const status = error.response.status;

      if (status === 429) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_RATE_LIMIT,
          `Rate limited: ${status}`
        );
      }

      if (status >= 500) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_API_ERROR,
          `Server error: ${status} ${error.response.statusText}`
        );
      }

      if (status >= 400) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_FETCH_FAILED,
          `Client error: ${status} ${error.response.statusText}`
        );
      }
    }

    // Network error or unknown error
    throw new PolymarketError(
      ErrorCode.POLYMARKET_FETCH_FAILED,
      `Network error: ${error.message}`
    );
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get price history from CLOB API
   * Supports concurrent requests - each request is independent
   */
  async getClobPriceHistory(
    clobTokenId: string,
    params?: {
      startTs?: number;
      interval?: string;
      fidelity?: number;
    },
    retries: number = MAX_RETRIES
  ): Promise<PriceHistoryResponse> {
    const queryParams: Record<string, string | number> = {
      market: clobTokenId,
    };

    if (params?.startTs !== undefined) {
      queryParams.startTs = params.startTs;
    }

    if (params?.interval) {
      queryParams.interval = params.interval;
    }

    if (params?.fidelity !== undefined) {
      queryParams.fidelity = params.fidelity;
    }

    const config: AxiosRequestConfig = {
      method: 'GET',
      url: '/prices-history',
      params: queryParams,
    };

    let lastError: AxiosError | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = getRetryDelay(attempt - 1);
          logger.warn({
            message: 'Retrying Polymarket CLOB API request',
            attempt,
            maxRetries: retries,
            delay,
            clobTokenId,
          });
          await this.sleep(delay);
        }

        const response = await this.clobClient.request<PriceHistoryResponse>(config);
        return response.data;
      } catch (error) {
        lastError = error as AxiosError;

        if (!isRetryableError(lastError) || attempt === retries) {
          break;
        }

        // Check for rate limiting
        if (lastError.response?.status === 429) {
          const retryAfter = lastError.response.headers['retry-after'];
          if (retryAfter) {
            const delay = parseInt(retryAfter, 10) * 1000;
            logger.warn({
              message: 'Rate limited by Polymarket CLOB API',
              retryAfter: delay,
              clobTokenId,
            });
            await this.sleep(delay);
          }
        }
      }
    }

    // Handle final error
    return this.handleClobError(lastError!, clobTokenId);
  }

  /**
   * Get orderbooks from CLOB API
   * POST request to /books with array of token IDs
   */
  async getOrderBooks(
    tokenIds: string[],
    retries: number = MAX_RETRIES
  ): Promise<OrderBookResponse[]> {
    // Validate token IDs
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
      throw new PolymarketError(
        ErrorCode.BAD_REQUEST,
        'tokenIds must be a non-empty array'
      );
    }

    // Prepare request body
    const requestBody: OrderBookRequest[] = tokenIds.map((tokenId) => ({
      token_id: tokenId,
    }));

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: '/books',
      data: requestBody,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    let lastError: AxiosError | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = getRetryDelay(attempt - 1);
          logger.warn({
            message: 'Retrying Polymarket CLOB API request',
            attempt,
            maxRetries: retries,
            delay,
            endpoint: '/books',
            tokenCount: tokenIds.length,
          });
          await this.sleep(delay);
        }

        const response = await this.clobClient.request<OrderBookResponse[]>(config);

        // logger.info({
        //   message: 'Orderbooks fetched successfully',
        //   tokenCount: tokenIds.length,
        //   orderbookCount: response.data?.length || 0,
        // });

        return response.data;
      } catch (error) {
        lastError = error as AxiosError;

        if (!isRetryableError(lastError) || attempt === retries) {
          break;
        }

        // Check for rate limiting
        if (lastError.response?.status === 429) {
          const retryAfter = lastError.response.headers['retry-after'];
          if (retryAfter) {
            const delay = parseInt(retryAfter, 10) * 1000;
            logger.warn({
              message: 'Rate limited by Polymarket CLOB API',
              retryAfter: delay,
              endpoint: '/books',
            });
            await this.sleep(delay);
          }
        }
      }
    }

    // Handle final error
    return this.handleOrderBooksError(lastError!, tokenIds);
  }

  /**
   * Handle CLOB API errors for orderbooks and convert to custom errors
   */
  private handleOrderBooksError(error: AxiosError, tokenIds: string[]): never {
    logger.error({
      message: 'Polymarket CLOB API orderbooks request failed',
      tokenCount: tokenIds.length,
      status: error.response?.status,
      statusText: error.response?.statusText,
      error: error.message,
      responseData: error.response?.data,
    });

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new PolymarketError(
        ErrorCode.POLYMARKET_TIMEOUT,
        `CLOB API orderbooks request timeout: ${error.message}`
      );
    }

    if (error.response) {
      const status = error.response.status;

      if (status === 429) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_RATE_LIMIT,
          `CLOB API orderbooks rate limited: ${status}`
        );
      }

      if (status >= 500) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_API_ERROR,
          `CLOB API orderbooks server error: ${status} ${error.response.statusText}`
        );
      }

      if (status >= 400) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_FETCH_FAILED,
          `CLOB API orderbooks client error: ${status} ${error.response.statusText}`
        );
      }
    }

    // Network error or unknown error
    throw new PolymarketError(
      ErrorCode.POLYMARKET_FETCH_FAILED,
      `CLOB API orderbooks network error: ${error.message}`
    );
  }

  /**
   * Handle CLOB API errors and convert to custom errors
   */
  private handleClobError(error: AxiosError, clobTokenId: string): never {
    logger.error({
      message: 'Polymarket CLOB API request failed',
      clobTokenId,
      status: error.response?.status,
      statusText: error.response?.statusText,
      error: error.message,
      responseData: error.response?.data,
    });

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new PolymarketError(
        ErrorCode.POLYMARKET_TIMEOUT,
        `CLOB API request timeout: ${error.message}`
      );
    }

    if (error.response) {
      const status = error.response.status;

      if (status === 429) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_RATE_LIMIT,
          `CLOB API rate limited: ${status}`
        );
      }

      if (status >= 500) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_API_ERROR,
          `CLOB API server error: ${status} ${error.response.statusText}`
        );
      }

      if (status >= 400) {
        throw new PolymarketError(
          ErrorCode.POLYMARKET_FETCH_FAILED,
          `CLOB API client error: ${status} ${error.response.statusText}`
        );
      }
    }

    // Network error or unknown error
    throw new PolymarketError(
      ErrorCode.POLYMARKET_FETCH_FAILED,
      `CLOB API network error: ${error.message}`
    );
  }

  /**
   * Get request statistics
   */
  getStats() {
    return {
      requestCount: this.requestCount,
      lastRequestTime: this.lastRequestTime,
    };
  }
}

// Export singleton instance
export const polymarketClient = new PolymarketClient();

