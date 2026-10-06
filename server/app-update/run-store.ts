import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { updateRunEvents, updateRuns } from "@shared/schema";
import type { UpdateEvent, UpdateRunView } from "@shared/api-types";

export type RunStatus = UpdateRunView["status"];

export interface NewRun {
  fromVersion: string;
  toVersion: string;
  triggeredBy: string | null;
  triggeredByUsername: string | null;
}

/** Persistence for update runs (`update_runs` + `update_run_events`). */
export interface UpdateRunStore {
  create(run: NewRun): Promise<string>;
  appendEvent(runId: string, event: UpdateEvent): Promise<void>;
  finish(runId: string, status: RunStatus, message: string | null): Promise<void>;
  get(id: string): Promise<UpdateRunView | null>;
  latest(): Promise<UpdateRunView | null>;
  list(limit: number): Promise<Omit<UpdateRunView, "events">[]>;
  listRunning(): Promise<{ id: string; toVersion: string | null }[]>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class DbRunStore implements UpdateRunStore {
  async create(run: NewRun) {
    const id = randomUUID();
    await db.insert(updateRuns).values({ id, ...run, status: "running" });
    return id;
  }

  async appendEvent(runId: string, e: UpdateEvent) {
    await db.insert(updateRunEvents).values({
      runId,
      step: e.step,
      status: e.status,
      message: e.message,
      progress: e.progress ?? null,
      createdAt: new Date(e.at),
    });
  }

  async finish(runId: string, status: RunStatus, message: string | null) {
    await db.update(updateRuns).set({ status, finalMessage: message, finishedAt: new Date() }).where(eq(updateRuns.id, runId));
  }

  private toView(r: typeof updateRuns.$inferSelect): Omit<UpdateRunView, "events"> {
    return {
      id: r.id,
      status: r.status as RunStatus,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      triggeredByUsername: r.triggeredByUsername,
      finalMessage: r.finalMessage,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
    };
  }

  async get(id: string) {
    const [run] = await db.select().from(updateRuns).where(eq(updateRuns.id, id)).limit(1);
    if (!run) return null;
    const events = await db.select().from(updateRunEvents).where(eq(updateRunEvents.runId, id)).orderBy(asc(updateRunEvents.id));
    return {
      ...this.toView(run),
      events: events.map((e) => ({
        step: e.step as UpdateEvent["step"],
        status: e.status as UpdateEvent["status"],
        message: e.message,
        progress: e.progress ?? undefined,
        at: e.createdAt.toISOString(),
      })),
    };
  }

  async latest() {
    const [run] = await db.select({ id: updateRuns.id }).from(updateRuns).orderBy(desc(updateRuns.startedAt)).limit(1);
    return run ? this.get(run.id) : null;
  }

  async list(limit: number) {
    const rows = await db.select().from(updateRuns).orderBy(desc(updateRuns.startedAt)).limit(limit);
    return rows.map((r) => this.toView(r));
  }

  async listRunning() {
    return db.select({ id: updateRuns.id, toVersion: updateRuns.toVersion }).from(updateRuns).where(eq(updateRuns.status, "running"));
  }
}

/** In-memory store for tests and database-less tooling. */
export class MemoryRunStore implements UpdateRunStore {
  runs: UpdateRunView[] = [];

  async create(run: NewRun) {
    const id = randomUUID();
    this.runs.push({
      id,
      status: "running",
      fromVersion: run.fromVersion,
      toVersion: run.toVersion,
      triggeredByUsername: run.triggeredByUsername,
      finalMessage: null,
      startedAt: new Date(Date.now() + this.runs.length).toISOString(),
      finishedAt: null,
      events: [],
    });
    return id;
  }
  async appendEvent(runId: string, e: UpdateEvent) {
    this.runs.find((r) => r.id === runId)?.events.push(e);
  }
  async finish(runId: string, status: RunStatus, message: string | null) {
    const r = this.runs.find((x) => x.id === runId);
    if (r) Object.assign(r, { status, finalMessage: message, finishedAt: new Date().toISOString() });
  }
  async get(id: string) {
    return this.runs.find((r) => r.id === id) ?? null;
  }
  async latest() {
    return this.runs.at(-1) ?? null;
  }
  async list(limit: number) {
    return [...this.runs].reverse().slice(0, limit).map(({ events: _e, ...r }) => r);
  }
  async listRunning() {
    return this.runs.filter((r) => r.status === "running").map((r) => ({ id: r.id, toVersion: r.toVersion }));
  }
}

let store: UpdateRunStore = new DbRunStore();
export const runStore = () => store;
export function setUpdateRunStore(s: UpdateRunStore) {
  store = s;
}
