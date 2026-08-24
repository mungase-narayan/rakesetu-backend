/**
 * Standard application error: extends Error with HTTP statusCode,
 * a structured errors list, and a success flag. Thrown by controllers
 * and services; serialized by the global error handler.
 */
import ERROR_MESSAGE from "../constants/error-message.constants";

class ApiError extends Error {
  statusCode: number;
  data: unknown | null;
  success: boolean;
  errors: unknown[];

  constructor(
    statusCode: number,
    message: string = ERROR_MESSAGE.SERVER_ERROR,
    errors: unknown[] = [],
    stack: string = "",
  ) {
    super(message);
    this.statusCode = statusCode;
    this.data = null;
    this.message = message;
    this.success = false;
    this.errors = errors;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export default ApiError;
