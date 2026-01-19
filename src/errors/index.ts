/**
 * Base application error with cause tracking
 */
export class ProcessingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ProcessingError";
  }
}

/**
 * Error for geometry type issues
 */
export class GeometryError extends ProcessingError {
  constructor(
    message: string,
    public readonly geometryType?: string
  ) {
    super(message);
    this.name = "GeometryError";
  }
}

/**
 * Error for data validation failures
 */
export class ValidationError extends ProcessingError {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Error for database operation failures
 */
export class DatabaseError extends ProcessingError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "DatabaseError";
  }
}

/**
 * Error for external API/service failures
 */
export class ExternalServiceError extends ProcessingError {
  constructor(
    message: string,
    public readonly service: string,
    cause?: unknown
  ) {
    super(message, cause);
    this.name = "ExternalServiceError";
  }
}
