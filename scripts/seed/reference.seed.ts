/**
 * Commodities and wagon types — the two global catalogues.
 */
/* eslint-disable no-console */
import { db } from "../../src/database/connection";
import { commodities, wagonTypes } from "../../src/schema";
import { COMMODITIES, WAGON_TYPES } from "./data/reference.data";

export interface ReferenceCounts {
  commodities: number;
  wagonTypes: number;
}

export const seedReference = async (): Promise<ReferenceCounts> => {
  await db
    .insert(commodities)
    .values(
      COMMODITIES.map((commodity) => ({
        code: commodity.code,
        name: commodity.name,
        group: commodity.group,
        class: commodity.class,
        minWeightCondition: commodity.minWeightCondition,
        isHazardous: commodity.isHazardous ?? false,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(wagonTypes)
    .values(
      WAGON_TYPES.map((type) => ({
        code: type.code,
        name: type.name,
        tareT: type.tareT,
        ccT: type.ccT,
        ccPlus82T: type.ccPlus82T,
        commodityGroups: type.commodityGroups,
        lengthM: type.lengthM,
        isCovered: type.isCovered ?? false,
      })),
    )
    .onConflictDoNothing();

  console.log(
    `  reference     ${COMMODITIES.length} commodities, ${WAGON_TYPES.length} wagon types`,
  );

  return {
    commodities: COMMODITIES.length,
    wagonTypes: WAGON_TYPES.length,
  };
};
