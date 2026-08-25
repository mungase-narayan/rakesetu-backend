export {
  wagonTypes,
  wagons,
  rakes,
  rakeCompositions,
  wagonOwnerEnum,
  wagonStatusEnum,
  rakeStateEnum,
  WAGON_OWNERS,
  WAGON_STATUSES,
  RAKE_STATES,
} from "../../schema";
export type {
  WagonType,
  NewWagonType,
  UpdateWagonType,
  Wagon,
  NewWagon,
  UpdateWagon,
  Rake,
  NewRake,
  UpdateRake,
  RakeComposition,
  NewRakeComposition,
  WagonOwner,
  WagonStatus,
  RakeState,
} from "../../schema";

export { default as WagonTypeService } from "./services/wagon-type.service";
export { default as WagonService } from "./services/wagon.service";
export { default as RakeService } from "./services/rake.service";
export type { RakeConstraints, CompositionEntry } from "./types/asset.types";
export {
  wagonTypeRouter,
  wagonRouter,
  rakeRouter,
} from "./routes/asset.routes";
