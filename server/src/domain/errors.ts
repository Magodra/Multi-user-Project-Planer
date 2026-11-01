/** Error types shared by domain, services, storage and the API layers. */

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION", 400, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Not allowed") {
    super("FORBIDDEN", 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super("NOT_FOUND", 404, `${entity} ${id} not found`);
  }
}

/** Optimistic locking failure: the stored version differs from the given one. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", 409, message);
  }
}

/** A business rule was violated (e.g. modifying a locked baseline). */
export class RuleViolationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("RULE_VIOLATION", 422, message, details);
  }
}
