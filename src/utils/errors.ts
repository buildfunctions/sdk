/**
 * Buildfunctions SDK Error Classes
 */

import type { ErrorCode } from '../types/index.js';

export class BuildfunctionsError extends Error {
  readonly code: ErrorCode;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode = 'UNKNOWN_ERROR',
    statusCode?: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BuildfunctionsError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, BuildfunctionsError.prototype);
  }

  static fromResponse(statusCode: number, body: { error?: string; code?: string }): BuildfunctionsError {
    const message = body.error ?? 'An unknown error occurred';
    const code = mapErrorCode(body.code, statusCode);
    return new BuildfunctionsError(message, code, statusCode);
  }
}

export class AuthenticationError extends BuildfunctionsError {
  constructor(message = 'Invalid or missing API key') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

export class NotFoundError extends BuildfunctionsError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class ValidationError extends BuildfunctionsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class CapacityError extends BuildfunctionsError {
  constructor(message = 'Service at maximum capacity. Please try again later.') {
    super(message, 'MAX_CAPACITY', 503);
    this.name = 'CapacityError';
    Object.setPrototypeOf(this, CapacityError.prototype);
  }
}

function mapErrorCode(code: string | undefined, statusCode: number): ErrorCode {
  if (code) {
    const validCodes: ErrorCode[] = [
      'UNAUTHORIZED',
      'NOT_FOUND',
      'INVALID_REQUEST',
      'MAX_CAPACITY',
      'SIZE_LIMIT_EXCEEDED',
      'VALIDATION_ERROR',
    ];
    if (validCodes.includes(code as ErrorCode)) {
      return code as ErrorCode;
    }
  }

  switch (statusCode) {
    case 401:
      return 'UNAUTHORIZED';
    case 404:
      return 'NOT_FOUND';
    case 400:
      return 'INVALID_REQUEST';
    case 503:
      return 'MAX_CAPACITY';
    case 409:
      return 'SIZE_LIMIT_EXCEEDED';
    default:
      return 'UNKNOWN_ERROR';
  }
}
