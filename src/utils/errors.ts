/**
 * Error utilities and custom error classes
 */

export enum ErrorCode {
  // General errors
  BAD_REQUEST = 'BAD_REQUEST',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  
  // Polymarket API errors
  POLYMARKET_FETCH_FAILED = 'POLYMARKET_FETCH_FAILED',
  POLYMARKET_API_ERROR = 'POLYMARKET_API_ERROR',
  POLYMARKET_TIMEOUT = 'POLYMARKET_TIMEOUT',
  POLYMARKET_RATE_LIMIT = 'POLYMARKET_RATE_LIMIT',
  
  // Data errors
  DATA_PARSING_ERROR = 'DATA_PARSING_ERROR',
  TRANSFORMATION_ERROR = 'TRANSFORMATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  
  // Database errors
  DATABASE_ERROR = 'DATABASE_ERROR',
  DATABASE_CONNECTION_ERROR = 'DATABASE_CONNECTION_ERROR',
}

/**
 * Base custom error class
 */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error
 */
export class ValidationError extends AppError {
  constructor(code: ErrorCode, message: string, details?: any) {
    super(code, message, 400, details);
  }
}

/**
 * Polymarket API error
 */
export class PolymarketError extends AppError {
  constructor(code: ErrorCode, message: string, details?: any) {
    super(code, message, 502, details);
  }
}

/**
 * Transformation error
 */
export class TransformationError extends AppError {
  constructor(code: ErrorCode, message: string, details?: any) {
    super(code, message, 500, details);
  }
}

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(code: ErrorCode, message: string, details?: any) {
    super(code, message, 500, details);
  }
}

