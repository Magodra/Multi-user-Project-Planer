import type { Role } from "@planning/shared";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { AccessService } from "./AccessService.js";
import { AuditService } from "./AuditService.js";
import { BaselineService } from "./BaselineService.js";
import { ChangeRequestService } from "./ChangeRequestService.js";
import { EventBus } from "./events.js";
import { ItemService } from "./ItemService.js";
import { LinkService } from "./LinkService.js";
import { PlanService } from "./PlanService.js";
import { ProjectService } from "./ProjectService.js";
import { ReportService } from "./reports/ReportService.js";
import { TimelineService, WorkspaceService } from "./TimelineService.js";
import { UserService } from "./UserService.js";

export interface ServiceOptions {
  passwordMinLength: number;
  roleMapping: Record<string, Role>;
}

/** All services wired together. REST, MCP and WebSocket layers only talk to this. */
export class Services {
  readonly events = new EventBus();
  readonly access: AccessService;
  readonly audit: AuditService;
  readonly users: UserService;
  readonly projects: ProjectService;
  readonly plans: PlanService;
  readonly items: ItemService;
  readonly links: LinkService;
  readonly baselines: BaselineService;
  readonly changeRequests: ChangeRequestService;
  readonly timelines: TimelineService;
  readonly workspaces: WorkspaceService;
  readonly reports: ReportService;

  constructor(
    readonly storage: StorageAdapter,
    options: ServiceOptions,
  ) {
    this.access = new AccessService(storage);
    this.audit = new AuditService(storage, this.access);
    this.users = new UserService(storage, this.audit, options);
    this.projects = new ProjectService(storage, this.access, this.audit, this.events);
    this.plans = new PlanService(storage, this.access, this.audit, this.events);
    this.items = new ItemService(storage, this.access, this.audit, this.events);
    this.links = new LinkService(storage, this.access, this.audit, this.events);
    this.baselines = new BaselineService(storage, this.access, this.audit, this.events);
    this.changeRequests = new ChangeRequestService(
      storage,
      this.access,
      this.audit,
      this.events,
      this.baselines,
    );
    this.timelines = new TimelineService(storage, this.access, this.audit, this.events);
    this.workspaces = new WorkspaceService(storage, this.access);
    this.reports = new ReportService(storage, this.access, this.audit, this.baselines);
  }
}
