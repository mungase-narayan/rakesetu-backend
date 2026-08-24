/**
 * Standard successful response envelope: wraps a status code, message,
 * and payload so all endpoints return a consistent JSON shape.
 *
 * The frontend's axios layer unwraps exactly this shape
 * (`res.data.data`) — do not introduce a competing envelope.
 */
class ApiResponse {
  statusCode: number;
  data: unknown;
  message: string;
  success: boolean;

  constructor(statusCode: number, data: unknown, message: string = "Success") {
    this.statusCode = statusCode;
    this.data = data;
    this.message = message;
    this.success = statusCode < 400;
  }
}

export default ApiResponse;
