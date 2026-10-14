export class HttpFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, retryable = false) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.name = "HttpFailure";
  }
}
