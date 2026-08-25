/**
 * sections CRUD.
 *
 * Global reference data, so `UnscopedRepository`. Every write busts the Redis
 * graph cache — a section whose speed was edited but whose cached edge still
 * says otherwise would produce ETAs nobody can explain, and the cache TTL is an
 * hour, which is a long time to be confidently wrong.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";

import { sections } from "../../../schema";
import { UnscopedRepository } from "../../../database/scoped-repository";
import type { DB } from "../../../database/connection";
import type {
  IListSectionsQuery,
  NewSection,
  Section,
} from "../types/network.types";
import DistanceService from "./distance.service";

class SectionService {
  private readonly repo: UnscopedRepository<typeof sections>;

  constructor(
    private readonly distanceService: DistanceService = new DistanceService(),
    database?: DB,
  ) {
    this.repo = new UnscopedRepository(sections, sections.id, database);
  }

  async list(query: IListSectionsQuery = {}) {
    return this.repo.paginate(
      {
        ...query,
        sort: query.sort ?? "fromCode",
        order: query.order ?? "asc",
      },
      this.filters(query),
    );
  }

  async listAll(): Promise<Section[]> {
    return this.repo.select(undefined, asc(sections.fromCode));
  }

  async findById(id: string): Promise<Section | null> {
    return this.repo.findByKey(id);
  }

  async create(values: NewSection): Promise<Section> {
    const row = await this.repo.insert({
      ...values,
      fromCode: values.fromCode.toUpperCase(),
      toCode: values.toCode.toUpperCase(),
    });
    await this.distanceService.invalidateGraphCache();
    return row;
  }

  /** Bulk insert for the CSV import — one round trip, one invalidation. */
  async createMany(values: NewSection[]): Promise<Section[]> {
    const rows = await this.repo.insertMany(
      values.map((value) => ({
        ...value,
        fromCode: value.fromCode.toUpperCase(),
        toCode: value.toCode.toUpperCase(),
      })),
    );
    await this.distanceService.invalidateGraphCache();
    return rows;
  }

  async update(
    id: string,
    values: Partial<NewSection>,
  ): Promise<Section | null> {
    const row = await this.repo.update(id, values);
    if (row) await this.distanceService.invalidateGraphCache();
    return row;
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await this.repo.delete(id);
    if (deleted) await this.distanceService.invalidateGraphCache();
    return deleted;
  }

  private filters(query: IListSectionsQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.fromCode) {
      conditions.push(eq(sections.fromCode, query.fromCode.toUpperCase()));
    }
    if (query.toCode) {
      conditions.push(eq(sections.toCode, query.toCode.toUpperCase()));
    }
    if (query.lineType) conditions.push(eq(sections.lineType, query.lineType));

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default SectionService;
