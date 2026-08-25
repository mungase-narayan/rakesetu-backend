export {
  terminals,
  embargoes,
  terminalTypeEnum,
  handlingModeEnum,
  TERMINAL_TYPES,
  HANDLING_MODES,
} from "../../schema";
export type {
  Terminal,
  NewTerminal,
  UpdateTerminal,
  Embargo,
  NewEmbargo,
  UpdateEmbargo,
  TerminalType,
  HandlingMode,
} from "../../schema";

export { default as TerminalService } from "./services/terminal.service";
export { default as EmbargoService } from "./services/embargo.service";
export {
  describeScope,
  matchesScope,
  assertScopeVersion,
} from "./services/embargo-scope";
export type { EmbargoCandidate } from "./services/embargo-scope";
export type { EmbargoWithSummary } from "./types/terminal.types";
export { terminalRouter, embargoRouter } from "./routes/terminal.routes";
