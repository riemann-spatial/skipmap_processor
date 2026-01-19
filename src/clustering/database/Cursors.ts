import { Pool } from "pg";
import { MapObject } from "../MapObject";
import { Cursor } from "./ClusteringDatabase";
import { ObjectRow, SQLParamValue } from "./types";

/**
 * Empty cursor that returns no results
 */
export class EmptyCursor<T> implements Cursor<T> {
  async nextBatch(): Promise<T[] | null> {
    return null;
  }

  async all(): Promise<T[]> {
    return [];
  }
}

/**
 * Generic cursor that fetches data from PostgreSQL in batches to minimize memory usage.
 * Instead of loading all results upfront, this cursor fetches data on-demand using LIMIT/OFFSET.
 */
export class PostgreSQLCursor<T extends MapObject> implements Cursor<T> {
  private offset = 0;
  private readonly batchSize: number;
  private isExhausted = false;

  constructor(
    private pool: Pool,
    private query: string,
    private params: SQLParamValue[],
    private rowMapper: (row: ObjectRow) => T,
    batchSize = 1000,
  ) {
    this.batchSize = batchSize;

    // Validate that queries using batching have ORDER BY for deterministic results
    if (batchSize < Number.MAX_SAFE_INTEGER && !this.hasOrderBy(query)) {
      throw new Error(
        "Query must include ORDER BY clause for deterministic pagination. " +
          "Without ORDER BY, OFFSET-based batching can skip or duplicate rows.\n" +
          `Query: ${query.substring(0, 100)}...`,
      );
    }
  }

  /**
   * Checks if the query contains an ORDER BY clause.
   */
  private hasOrderBy(query: string): boolean {
    const normalizedQuery = query.trim().replace(/\s+/g, " ").toUpperCase();
    return normalizedQuery.includes(" ORDER BY ");
  }

  async nextBatch(): Promise<T[] | null> {
    if (this.isExhausted) {
      return null;
    }

    const client = await this.pool.connect();
    try {
      const paginatedQuery = `${this.query} LIMIT $${this.params.length + 1} OFFSET $${this.params.length + 2}`;
      const paginatedParams = [...this.params, this.batchSize, this.offset];

      const result = await client.query(paginatedQuery, paginatedParams);

      // Update offset BEFORE mapping to prevent corruption if rowMapper throws
      this.offset += result.rows.length;

      if (result.rows.length < this.batchSize) {
        this.isExhausted = true;
      }

      const batch = result.rows.map(this.rowMapper);
      return batch.length > 0 ? batch : null;
    } finally {
      client.release();
    }
  }

  async all(): Promise<T[]> {
    const results: T[] = [];
    let batch: T[] | null;
    while ((batch = await this.nextBatch()) !== null) {
      results.push(...batch);
    }
    return results;
  }
}
