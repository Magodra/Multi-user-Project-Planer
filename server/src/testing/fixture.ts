/** A project with three users and two plans, for service tests. */
import type { Plan, Project, Task, User } from "@planning/shared";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { Services } from "../services/Services.js";
import type { ServiceContext } from "../services/support.js";

export interface Fixture {
  services: Services;
  admin: ServiceContext;
  alice: ServiceContext; // PLAN_OWNER of plan A
  bob: ServiceContext; // PLAN_OWNER of plan B
  carol: ServiceContext; // VIEWER
  outsider: ServiceContext; // no role in the project
  project: Project;
  planA: Plan;
  planB: Plan;
  task(
    name: string,
    extra?: Partial<{
      duration: number;
      parentId: string | null;
      ownership: "INTERNAL" | "EXTERNAL";
      start: string;
      planId: string;
    }>,
  ): Promise<Task>;
}

export const MONDAY = "2026-01-05T00:00:00.000Z";

const ui = (user: User): ServiceContext => ({ user, origin: "UI" });

export async function createFixture(storage: StorageAdapter): Promise<Fixture> {
  const services = new Services(storage, { passwordMinLength: 4, roleMapping: {} });
  const adminUser = await services.users.setupFirstAdmin({
    username: "admin",
    displayName: "Admin",
    email: "",
    password: "secret",
  });
  const admin = ui(adminUser);
  const mk = async (username: string) =>
    ui(
      await services.users.createUser(admin, {
        username,
        displayName: username,
        email: "",
        password: "secret",
        isSystemAdmin: false,
        partyIds: [],
      }),
    );
  const [alice, bob, carol, outsider] = await Promise.all([
    mk("alice"),
    mk("bob"),
    mk("carol"),
    mk("outsider"),
  ]);

  const project = await services.projects.create(admin, {
    name: "Apollo",
    projectType: "",
    description: "",
    parentProjectId: null,
  });
  const planA = await services.plans.create(admin, project.id, {
    name: "Contract",
    planType: "contract",
    description: "",
    ownerPartyId: null,
  });
  const planB = await services.plans.create(admin, project.id, {
    name: "Internal",
    planType: "internal",
    description: "",
    ownerPartyId: null,
  });
  await services.projects.assignRole(admin, project.id, {
    userId: alice.user.id,
    planId: planA.id,
    role: "PLAN_OWNER",
  });
  await services.projects.assignRole(admin, project.id, {
    userId: bob.user.id,
    planId: planB.id,
    role: "PLAN_OWNER",
  });
  await services.projects.assignRole(admin, project.id, {
    userId: carol.user.id,
    planId: null,
    role: "VIEWER",
  });

  return {
    services,
    admin,
    alice,
    bob,
    carol,
    outsider,
    project,
    planA,
    planB,
    task: (name, extra = {}) =>
      services.items.create(extra.planId === planB.id ? bob : alice, {
        planId: extra.planId ?? planA.id,
        parentId: extra.parentId ?? null,
        name,
        start: extra.start ?? MONDAY,
        duration: extra.duration ?? 5,
        granularity: "days",
        notes: "",
        ownership: extra.ownership ?? "INTERNAL",
      }),
  };
}
