/**
 * The ETA module's HTTP surface (§6).
 *
 * Two things are deliberate about the shapes here.
 *
 * **`GET /eta/rake/:id` answers 200 with a null and a reason**, not a 404. "This
 * rake is not in transit" is a successful answer to a legitimate question; a
 * 404 would make the map's error handling fire on the ordinary case of a rake
 * standing at a siding, and the client would have to distinguish it from a rake
 * that does not exist.
 *
 * **`confidence` is never rendered as a probability.** The field carries a
 * coverage label and `observedShare` carries the number behind it, so a screen
 * can say "most of this estimate comes from observed running" without implying
 * a confidence interval the system cannot compute until Phase 8.
 */
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import type { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import { asDate, asString, pathParam } from "../../../utils/controller";

import EtaLookupService from "../services/eta-lookup.service";
import SectionWeightService from "../services/section-weight.service";
import { NoRouteError } from "../services/eta.service";

interface EstimateBody {
  fromCode: string;
  toCode: string;
  departAt?: string;
  wagonTypeCode: string;
}

class EtaController {
  constructor(
    private readonly lookup: EtaLookupService,
    private readonly weights: SectionWeightService,
  ) {}

  async forRake(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const answer = await this.lookup.etaForRake(
      orgId,
      pathParam(req.params.rakeId),
    );

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          answer,
          answer.eta
            ? "ETA computed successfully."
            : "No ETA is available for this rake.",
        ),
      );
  }

  /**
   * The ad-hoc pair. **Phase 7 depends on this signature** — the solver's cost
   * function asks about journeys nobody has been allotted yet, so it cannot go
   * through the rake-shaped endpoint.
   */
  async estimate(req: CustomRequest<EstimateBody>, res: Response) {
    const { orgId } = requireTenant(req);
    const { fromCode, toCode, wagonTypeCode } = req.body;

    try {
      const eta = await this.lookup.estimate(orgId, {
        fromCode,
        toCode,
        wagonTypeCode,
        departAt: req.body.departAt ? new Date(req.body.departAt) : new Date(),
      });

      return res
        .status(200)
        .json(new ApiResponse(200, eta, "ETA computed successfully."));
    } catch (error) {
      if (error instanceof NoRouteError) {
        // 422, not 500: the request was well-formed and the network genuinely
        // has no path. The same status `tariffKm` uses for a pair nobody has
        // priced, and for the same reason — the caller has to say so.
        throw new ApiError(422, error.message);
      }
      throw error;
    }
  }

  /**
   * The debugging view: every section and band, with its minutes, its sample
   * count and where the number came from.
   *
   * `analytics:read` rather than `rake:read`. This is the inside of the engine,
   * and the audience is an administrator asking why an estimate looks wrong —
   * not the operating chain, which sees the answer and its provenance on the
   * rake detail sheet.
   */
  async sectionWeights(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const requested = asString(req.query.wagonTypeCode);
    const codes = await this.weights.wagonTypeCodes(orgId);

    if (codes.length === 0) {
      throw new ApiError(422, "This zone has no active rakes to weigh.");
    }
    if (requested && !codes.includes(requested)) {
      throw new ApiError(
        422,
        `No active rake of wagon type "${requested}" — weights exist for: ${codes.join(", ")}`,
      );
    }

    const table = await this.weights.weightTable(
      orgId,
      requested ?? codes[0],
      asDate(req.query.asOf) ?? new Date(),
    );

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { ...table, wagonTypeCodes: codes },
          "Section weights fetched successfully.",
        ),
      );
  }
}

export default EtaController;
