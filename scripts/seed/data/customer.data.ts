/**
 * Twenty-five customers, spread across all four tiers.
 *
 * The spread is a requirement, not flavour: Phase 7's `slaRisk()` has no
 * delivery history to learn from on a fresh database, so `customers.tier` is its
 * entire cold start. A seed where everybody is `standard` gives the solver one
 * value for a variable it is supposed to discriminate on, and the objective
 * function silently loses a term.
 *
 * `sidings` name terminals by code; the seeder resolves them.
 */
import type { CustomerTier } from "../../../src/schema";

export interface CustomerSidingSeed {
  terminalCode: string;
  commodityCodes: string[];
  isDefaultLoading?: boolean;
  isDefaultDest?: boolean;
}

export interface CustomerSeed {
  code: string;
  name: string;
  tier: CustomerTier;
  gstin?: string;
  creditLimit?: number;
  contactEmail?: string;
  contactPhone?: string;
  /** Set for the one customer that also holds a portal login — see D7. */
  linkToTenantCode?: string;
  sidings: CustomerSidingSeed[];
}

export const CUSTOMERS: CustomerSeed[] = [
  {
    code: "ACC",
    name: "Aditya Cement Corporation",
    tier: "platinum",
    gstin: "27AACCA1234M1Z5",
    creditLimit: 45000000,
    contactEmail: "logistics@adityacement.example",
    contactPhone: "+912212345601",
    // The one customer with a tenant behind it. Phase 6's portal signs in as
    // this organization and reads its own indents through `customer_org_id`.
    linkToTenantCode: "ACC",
    sidings: [
      {
        terminalCode: "HG-SDG",
        commodityCodes: ["CEM"],
        isDefaultLoading: true,
      },
      {
        terminalCode: "PNVL-PFT",
        commodityCodes: ["CEM"],
        isDefaultDest: true,
      },
      { terminalCode: "SUR-PFT", commodityCodes: ["CEM"] },
    ],
  },
  {
    code: "MSPGCL",
    name: "Maharashtra State Power Generation Co.",
    tier: "platinum",
    gstin: "27AAECM4567P1Z2",
    creditLimit: 120000000,
    contactEmail: "fuel@mspgcl.example",
    sidings: [
      { terminalCode: "CD-SDG", commodityCodes: ["COAL"], isDefaultDest: true },
      {
        terminalCode: "BPQ-SDG",
        commodityCodes: ["COAL"],
        isDefaultLoading: true,
      },
    ],
  },
  {
    code: "WCL",
    name: "Western Coalfields Limited",
    tier: "platinum",
    gstin: "27AAACW7890K1Z8",
    creditLimit: 90000000,
    contactEmail: "despatch@wcl.example",
    sidings: [
      {
        terminalCode: "BPQ-SDG",
        commodityCodes: ["COAL"],
        isDefaultLoading: true,
      },
    ],
  },
  {
    code: "ULTRA",
    name: "Ultratech Cement Solapur",
    tier: "gold",
    gstin: "27AAACU2345L1Z1",
    creditLimit: 38000000,
    sidings: [
      {
        terminalCode: "SUR-PFT",
        commodityCodes: ["CEM"],
        isDefaultLoading: true,
      },
      { terminalCode: "PUNE-GS", commodityCodes: ["CEM"], isDefaultDest: true },
    ],
  },
  {
    code: "AMBUJA",
    name: "Ambuja Cements Western Region",
    tier: "gold",
    creditLimit: 32000000,
    sidings: [{ terminalCode: "HG-SDG", commodityCodes: ["CEM"] }],
  },
  {
    code: "JSWSTL",
    name: "JSW Steel Coastal Logistics",
    tier: "gold",
    creditLimit: 55000000,
    sidings: [
      {
        terminalCode: "PNVL-PFT",
        commodityCodes: ["STL"],
        isDefaultLoading: true,
      },
      { terminalCode: "NGP-GS", commodityCodes: ["STL"], isDefaultDest: true },
    ],
  },
  {
    code: "TATASTL",
    name: "Tata Steel Long Products",
    tier: "gold",
    creditLimit: 48000000,
    sidings: [{ terminalCode: "NGP-GS", commodityCodes: ["STL"] }],
  },
  {
    code: "IOCL",
    name: "Indian Oil Corporation — Miraj",
    tier: "platinum",
    creditLimit: 75000000,
    sidings: [
      { terminalCode: "MRJ-SDG", commodityCodes: ["POL"], isDefaultDest: true },
    ],
  },
  {
    code: "BPCL",
    name: "Bharat Petroleum Western Depot",
    tier: "gold",
    creditLimit: 60000000,
    sidings: [{ terminalCode: "MRJ-SDG", commodityCodes: ["POL"] }],
  },
  {
    code: "FCI",
    name: "Food Corporation of India — Pune Region",
    tier: "gold",
    creditLimit: 40000000,
    sidings: [
      {
        terminalCode: "PUNE-GS",
        commodityCodes: ["FOOD"],
        isDefaultDest: true,
      },
      {
        terminalCode: "AK-GS",
        commodityCodes: ["FOOD"],
        isDefaultLoading: true,
      },
    ],
  },
  {
    code: "RCF",
    name: "Rashtriya Chemicals & Fertilizers",
    tier: "silver",
    creditLimit: 22000000,
    sidings: [
      { terminalCode: "DD-SDG", commodityCodes: ["FERT"], isDefaultDest: true },
    ],
  },
  {
    code: "IFFCO",
    name: "IFFCO Marketing — Maharashtra",
    tier: "silver",
    creditLimit: 18000000,
    sidings: [{ terminalCode: "AK-GS", commodityCodes: ["FERT"] }],
  },
  {
    code: "CONCOR",
    name: "Container Corporation of India",
    tier: "platinum",
    creditLimit: 85000000,
    sidings: [
      {
        terminalCode: "JNPT-PORT",
        commodityCodes: ["STL", "CEM"],
        isDefaultLoading: true,
      },
      { terminalCode: "PNVL-PFT", commodityCodes: ["STL", "CEM"] },
    ],
  },
  {
    code: "GATEWAY",
    name: "Gateway Rail Freight",
    tier: "gold",
    creditLimit: 44000000,
    sidings: [{ terminalCode: "JNPT-PORT", commodityCodes: ["CEM", "STL"] }],
  },
  {
    code: "DECCAN",
    name: "Deccan Agro Traders",
    tier: "silver",
    creditLimit: 9000000,
    sidings: [{ terminalCode: "KWV-GS", commodityCodes: ["FOOD"] }],
  },
  {
    code: "SHREE",
    name: "Shree Cement Marketing",
    tier: "silver",
    creditLimit: 15000000,
    sidings: [{ terminalCode: "KWV-GS", commodityCodes: ["CEM"] }],
  },
  {
    code: "BIRLA",
    name: "Birla Corporation Cement",
    tier: "silver",
    creditLimit: 17500000,
    sidings: [{ terminalCode: "SUR-PFT", commodityCodes: ["CEM"] }],
  },
  {
    code: "NIRANI",
    name: "Nirani Sugars Logistics",
    tier: "standard",
    creditLimit: 4000000,
    sidings: [{ terminalCode: "KWV-GS", commodityCodes: ["FOOD"] }],
  },
  {
    code: "SAHYADRI",
    name: "Sahyadri Warehousing",
    tier: "standard",
    creditLimit: 3200000,
    sidings: [{ terminalCode: "PUNE-GS", commodityCodes: ["FOOD", "FERT"] }],
  },
  {
    code: "VIDARBHA",
    name: "Vidarbha Minerals",
    tier: "standard",
    creditLimit: 5500000,
    sidings: [{ terminalCode: "NGP-GS", commodityCodes: ["STL"] }],
  },
  {
    code: "GODAVARI",
    name: "Godavari Fertilisers",
    tier: "standard",
    creditLimit: 6800000,
    sidings: [{ terminalCode: "DD-SDG", commodityCodes: ["FERT"] }],
  },
  {
    code: "KRISHNA",
    name: "Krishna Valley Foodgrains",
    tier: "standard",
    creditLimit: 2900000,
    sidings: [{ terminalCode: "AK-GS", commodityCodes: ["FOOD"] }],
  },
  {
    code: "MARATHWADA",
    name: "Marathwada Steel Traders",
    tier: "standard",
    creditLimit: 3600000,
    sidings: [{ terminalCode: "SUR-PFT", commodityCodes: ["STL"] }],
  },
  {
    code: "KONKAN",
    name: "Konkan Freight Movers",
    tier: "standard",
    creditLimit: 2400000,
    sidings: [{ terminalCode: "PNVL-PFT", commodityCodes: ["CEM"] }],
  },
  {
    code: "SATPURA",
    name: "Satpura Coal Handlers",
    tier: "standard",
    creditLimit: 4700000,
    sidings: [{ terminalCode: "CD-SDG", commodityCodes: ["COAL"] }],
  },
];
