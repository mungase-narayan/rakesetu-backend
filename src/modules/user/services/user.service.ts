/**
 * User data-access service: encapsulates Drizzle queries against the
 * users table so controllers stay persistence-agnostic.
 */
import { desc, eq } from "drizzle-orm";

import { db } from "../../../database/connection";
import { users, type NewUser, type UpdateUser } from "../../../schema";

class UserService {
  private users;

  constructor(usersTable: typeof users) {
    this.users = usersTable;
  }

  async getAllUsers() {
    return db.select().from(this.users).orderBy(desc(this.users.createdAt));
  }

  async getUserById(id: string) {
    const [user] = await db
      .select()
      .from(this.users)
      .where(eq(this.users.id, id));

    return user;
  }

  async getUserByEmail(email: string) {
    const [user] = await db
      .select()
      .from(this.users)
      .where(eq(this.users.email, email));

    return user;
  }

  async getUserByUsername(username: string) {
    const [user] = await db
      .select()
      .from(this.users)
      .where(eq(this.users.username, username));

    return user;
  }

  async createUser(data: Omit<NewUser, "username"> & { username?: string }) {
    // Username defaults to the account email (globally unique like email) when
    // not supplied; users can change it later from settings.
    const values: NewUser = {
      ...data,
      username: data.username ?? data.email.toLowerCase(),
    };
    const [user] = await db.insert(this.users).values(values).returning();
    return user;
  }

  async updateUser(id: string, data: UpdateUser) {
    const [user] = await db
      .update(this.users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(this.users.id, id))
      .returning();

    return user;
  }

  async deleteUser(id: string) {
    return db.delete(this.users).where(eq(this.users.id, id));
  }
}

export default UserService;
