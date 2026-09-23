export interface Bindings {
  DB: D1Database;
  AI?: { run(model: string, options: unknown): Promise<unknown> };
  NL_MODEL?: string;
  APP_VERSION?: string;
  ASSETS?: Fetcher;
}

export type WorkerEnv = { Bindings: Bindings };
