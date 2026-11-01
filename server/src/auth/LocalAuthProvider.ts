import type { User } from "@planning/shared";
import { UnauthorizedError } from "../domain/errors.js";
import type { UserService } from "../services/UserService.js";
import type { AuthProvider } from "./AuthProvider.js";
import { verifyPassword } from "./passwords.js";

export class LocalAuthProvider implements AuthProvider {
  readonly mode = "local" as const;

  constructor(private readonly users: UserService) {}

  async login(username: string, password: string): Promise<User> {
    const user = await this.users.findByUsername(username);
    if (
      !user?.passwordHash ||
      user.authSource !== "local" ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      throw new UnauthorizedError("Invalid username or password");
    }
    return user;
  }
}
