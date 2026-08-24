/**
 * Express type augmentation: extends Express.User with the DB user shape
 * (minus hashPassword) so req.user is fully typed after auth middleware runs.
 */
import { User as DbUser } from "../schema";

declare global {
  namespace Express {
    interface User extends Omit<DbUser, "hashPassword"> {
      id: string;
    }
  }
}

export {};
